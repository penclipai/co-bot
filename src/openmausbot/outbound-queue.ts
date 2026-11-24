/**
 * OpenMausBotBridge 按会话串行出站队列、断线消息缓冲重放与失败重试发送器。
 */
import { scanAndRedactOutbound } from '../core/security.ts';
import { hardBreaks, plain } from '../format.ts';
import type { ChannelAction, ChannelSendOptions } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { rememberBounded, trimMapCap } from './mentions.ts';
import type { MsgRoute, OutboundBufferItem } from './types.ts';

export interface SendTextExtra {
  chatId?: string | null;
  noBuffer?: boolean;
  bufferOnFail?: boolean;
  skipSecurityScan?: boolean;
}

export function isTransportDisconnected(bridge: OpenMausBotBridge): boolean {
  return bridge.transport?.status?.()?.connected === false;
}

function bufferOutboundItem(bridge: OpenMausBotBridge, item: OutboundBufferItem): void {
  const now = bridge.now();
  bridge.disconnectedBuffer = bridge.disconnectedBuffer.filter((x) => x.expiresAt > now);
  bridge.disconnectedBuffer.push(item);
  const cap = Math.max(1, Number(bridge.outboundBufferMax) || 30);
  while (bridge.disconnectedBuffer.length > cap) bridge.disconnectedBuffer.shift();
  bridge.emitTelemetry('outbound_buffered', {
    chatId: item.chatId,
    summary: scanAndRedactOutbound(item.text).text,
  });
}

function enqueueOutboundTask<T>(bridge: OpenMausBotBridge, chatId: string, fn: () => Promise<T>): Promise<T> {
  const key = String(chatId || '_default');
  const prev = bridge.outboundQueue.get(key) ?? Promise.resolve();
  const task = prev.then(fn, fn);
  const tail = task.catch(() => {}).finally(() => {
    if (bridge.outboundQueue.get(key) === tail) bridge.outboundQueue.delete(key);
  });
  bridge.outboundQueue.set(key, tail);
  return task;
}

export async function drainOutboundQueue(bridge: OpenMausBotBridge, timeoutMs = 2000): Promise<void> {
  const pending = [...bridge.outboundQueue.values()];
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

export async function flushOutboundBuffer(bridge: OpenMausBotBridge): Promise<number> {
  if (isTransportDisconnected(bridge) || !bridge.disconnectedBuffer.length) return 0;
  const now = bridge.now();
  const items = bridge.disconnectedBuffer.splice(0).filter((it) => it.expiresAt > now);
  let replayed = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (isTransportDisconnected(bridge)) {
      for (const rem of items.slice(i)) bufferOutboundItem(bridge, rem);
      break;
    }
    const sid = await bridge.say(it.text, it.route, it.replyTo, it.actions, { chatId: it.chatId, noBuffer: true });
    if (sid != null) {
      replayed += 1;
      bridge.outboundReplayed += 1;
    }
  }
  if (replayed > 0) {
    bridge.emitTelemetry('outbound_replayed', { summary: `replayed=${replayed}` });
  }
  return replayed;
}

export async function sendBridgeText(
  bridge: OpenMausBotBridge,
  text: string,
  route: MsgRoute | { targetChatId?: string | null } | null = null,
  replyTo: string | null = null,
  actions: ChannelAction[] | null = null,
  extra: SendTextExtra = {},
): Promise<string | null> {
  const chatId = extra?.chatId || route?.targetChatId || bridge.selfChat;
  if (!chatId) {
    if (!bridge.warnedMissingSelfChat) {
      bridge.warnedMissingSelfChat = true;
      console.warn('[omb-send] 尚未获知目标会话 ID，请先在自聊发一条消息或在 config.json 配置 channel.options.selfChatId');
    }
    return null;
  }
  const caps = bridge.channelCaps();
  const useMarkdown = Boolean(bridge.markdown && caps?.markdown !== false);
  const formatted = bridge.outPrefix + (useMarkdown ? hardBreaks(text) : plain(text));
  const scan = extra?.skipSecurityScan
    ? { text: formatted, redacted: false, hits: [], totalHits: 0 }
    : scanAndRedactOutbound(formatted);
  const body = scan.text;
  if (scan.redacted) {
    bridge.securityRedactions = (Number(bridge.securityRedactions) || 0) + scan.totalHits;
    bridge.emitTelemetry('security_redacted', {
      chatId,
      kind: 'text',
      summary: `count=${scan.totalHits} types=${scan.hits.map((h) => h.type).join(',')}`,
    });
  }
  bridge.rememberEcho(body);
  const opts: ChannelSendOptions = {
    ...(replyTo && caps?.replyTo !== false ? { replyTo } : {}),
    ...(Array.isArray(actions) && actions.length && caps?.actions !== false ? { actions } : {}),
  };
  const msgRoute = route && 'botId' in route ? route : null;

  return enqueueOutboundTask(bridge, chatId, async () => {
    if (!extra?.noBuffer && isTransportDisconnected(bridge)) {
      bufferOutboundItem(bridge, {
        chatId,
        text,
        route: msgRoute,
        replyTo,
        actions,
        expiresAt: bridge.now() + (Number(bridge.outboundBufferTtlMs) || 5 * 60_000),
      });
      return null;
    }
    const retries = Math.max(0, Number(bridge.sendRetries) || 0);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const sentId = await bridge.transport.send(chatId, body, opts);
        if (sentId != null) {
          const sid = String(sentId);
          rememberBounded(bridge.ownIds, sid, 2000);
          if (msgRoute?.botId) {
            bridge.msgRoute.set(sid, msgRoute);
            trimMapCap(bridge.msgRoute, 500);
            bridge.saveState();
          }
          return sid;
        }
        return null;
      } catch (e) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, (Number(bridge.sendRetryDelayMs) || 400) * (attempt + 1)));
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        bridge.outboundFailures += 1;
        bridge.emitTelemetry('outbound_failed', { chatId, summary: msg || 'send failed' });
        if (!extra?.noBuffer && (isTransportDisconnected(bridge) || extra?.bufferOnFail)) {
          bufferOutboundItem(bridge, {
            chatId,
            text,
            route: msgRoute,
            replyTo,
            actions,
            expiresAt: bridge.now() + (Number(bridge.outboundBufferTtlMs) || 5 * 60_000),
          });
        }
        console.error('[omb-send]', msg);
      }
    }
    return null;
  });
}
