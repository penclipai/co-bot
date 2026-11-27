/**
 * 多 Bot 索引同步、主协调 Bot 身份对齐与外群独立 Thread 治理。
 */
import { clip } from '../format.ts';
import type { ChatType } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { rememberBounded, trimMapCap } from './mentions.ts';
import {
  COBOT_COORDINATOR_PROFILE,
  COBOT_COORDINATOR_SOUL,
  COBOT_COORDINATOR_TITLE,
  isManagedCobotSoul,
} from './persona.ts';
import type { OmbBot, OmbGroup, OmbHttpError, OmbTargetBot, OmbTaskSummary } from './types.ts';

/** 使短时 Bot 列表缓存失效（在 SSE Bot/群变更或任务增改后调用）。 */
export function invalidateBotListCache(bridge: OpenMausBotBridge): void {
  bridge.botListCache = null;
}

/** 读取 OpenMausBot Bot/群列表，默认复用 `botListCacheTtlMs` 内的短期缓存（可 `force: true` 强刷）。 */
export async function getCachedBotRoster(
  bridge: OpenMausBotBridge,
  { force = false }: { force?: boolean } = {},
): Promise<{ bots: OmbBot[]; groups: OmbGroup[] }> {
  const ttl = Number(bridge.botListCacheTtlMs ?? 3000);
  const cached = bridge.botListCache;
  if (!force && ttl > 0 && cached && (bridge.now() - cached.at) < ttl) {
    return { bots: cached.bots, groups: cached.groups };
  }
  const res = await bridge.client.listBots();
  const bots = Array.isArray(res?.bots) ? res.bots : [];
  const groups = Array.isArray(res?.groups) ? res.groups : [];
  bridge.botListCache = { at: bridge.now(), bots, groups };
  return { bots, groups };
}

/** 幂等同步 OpenMausBot 主 Bot 的 co-bot 名称、职责标题与受管 Soul。 */
export async function syncChiefBotIdentity(
  bridge: OpenMausBotBridge,
  bots: OmbBot[] | null = null,
): Promise<boolean> {
  if (!bridge.syncChiefIdentity || bridge.chiefIdentitySynced || typeof bridge.client?.patchBot !== 'function') {
    return false;
  }
  if (bridge.syncingChiefPromise) return bridge.syncingChiefPromise;
  bridge.syncingChiefPromise = (async () => {
    try {
      const list = Array.isArray(bots) ? bots : ((await getCachedBotRoster(bridge))?.bots ?? []);
      const visible = list.filter((b) => b && !b.hidden);
      const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
      if (!chief?.id) return false;
      bridge.chiefBotId = chief.id;

      const rawName = String(chief.name ?? '').trim();
      const patch: Record<string, string> = {};
      if ((!rawName || /^(open)?mausbot$/i.test(rawName)) && rawName !== bridge.botName) {
        patch.name = bridge.botName;
      }
      if (!String(chief.title ?? '').trim()) {
        patch.title = COBOT_COORDINATOR_TITLE;
      }
      const curSoul = String(chief.soul ?? '').trim();
      if (isManagedCobotSoul(curSoul) && curSoul !== COBOT_COORDINATOR_SOUL) {
        Object.assign(patch, COBOT_COORDINATOR_PROFILE);
      }
      if (Object.keys(patch).length > 0) {
        await bridge.withCliLoopbackFallback((c) => c.patchBot(chief.id, patch));
        invalidateBotListCache(bridge);
        const updated = { ...chief, ...patch };
        bridge.botById.set(chief.id, updated);
        for (const [tid, entry] of bridge.botByThread) {
          if (entry?.id === chief.id) bridge.botByThread.set(tid, { ...entry, ...patch });
        }
        console.log(`[co-bot] 已同步主 Bot 身份为 ${updated.name || bridge.botName}（${updated.title || COBOT_COORDINATOR_TITLE}）`);
      }
      bridge.chiefIdentitySynced = true;
      return true;
    } catch (e) {
      const err = e as OmbHttpError;
      if (err?.status === 400 || err?.status === 404) bridge.chiefIdentitySynced = true;
      return false;
    } finally {
      bridge.syncingChiefPromise = null;
    }
  })();
  return bridge.syncingChiefPromise;
}

/** 拉取 OpenMausBot Bot/协作群组列表并刷新按 ID 与 Thread 的双向索引。 */
export async function refreshMultiBot(
  bridge: OpenMausBotBridge,
  { force = false }: { force?: boolean } = {},
): Promise<OmbBot[]> {
  try {
    const { bots = [], groups = [] } = await getCachedBotRoster(bridge, { force });
    const visible = bots.filter((b) => !b.hidden);
    const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
    bridge.multiBotCache = visible.length > 1 || visibleGroups.length > 0;
    const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0] ?? null;
    bridge.chiefBotId = chief?.id ?? null;
    const indexEntities = <T extends { id: string; name: string; threadId: string; mainThreadId?: string; tasks?: OmbTaskSummary[] }>(
      list: T[],
      byId: Map<string, T>,
      byThread: Map<string, OmbTargetBot>,
      isGroup: boolean,
    ): void => {
      for (const item of list) {
        const entry = isGroup ? { ...item, isGroup: true } : item;
        byId.set(item.id, entry);
        if (item.threadId) byThread.set(item.threadId, entry);
        if (item.mainThreadId) byThread.set(item.mainThreadId, entry);
        for (const t of item.tasks ?? []) {
          if (t?.threadId) byThread.set(t.threadId, { ...entry, threadId: t.threadId });
        }
      }
      trimMapCap(byThread, 500);
    };
    indexEntities(bots, bridge.botById, bridge.botByThread, false);
    indexEntities(groups, bridge.groupById, bridge.groupByThread, true);
    if (bridge.syncChiefIdentity && !bridge.chiefIdentitySynced && bots.length > 0) {
      await syncChiefBotIdentity(bridge, bots);
    }
    return bots;
  } catch {
    return [];
  }
}

/** 按 Thread ID 反查所属 Bot 或多 Bot 协作群。 */
export async function resolveOwnerByThread(bridge: OpenMausBotBridge, threadId: string): Promise<OmbTargetBot | null> {
  if (bridge.botByThread.has(threadId)) return bridge.botByThread.get(threadId) ?? null;
  if (bridge.groupByThread.has(threadId)) return bridge.groupByThread.get(threadId) ?? null;
  await refreshMultiBot(bridge, { force: true });
  return bridge.botByThread.get(threadId) ?? bridge.groupByThread.get(threadId) ?? null;
}

export function getChatThread(bridge: OpenMausBotBridge, chatId: string, targetBot: OmbTargetBot): OmbTargetBot {
  if (!chatId || !targetBot || bridge.chats.isolateThreadsByChat === false) return targetBot;
  const cached = bridge.chatThreads.get(`${chatId}:${targetBot.id}`);
  return cached?.threadId ? { ...targetBot, threadId: cached.threadId } : targetBot;
}

export function setSelfThread(bridge: OpenMausBotBridge, targetBot: OmbTargetBot): void {
  if (!targetBot?.id || !targetBot?.threadId || isExternalThread(bridge, targetBot.threadId)) return;
  bridge.selfThreads.set(String(targetBot.id), {
    botId: targetBot.id,
    botName: targetBot.name,
    threadId: targetBot.threadId,
    ...(targetBot.isGroup ? { isGroup: true } : {}),
  });
  trimMapCap(bridge.selfThreads, 100);
  bridge.saveState();
}

export function isExternalThread(bridge: OpenMausBotBridge, threadId?: string | null): boolean {
  if (!threadId) return false;
  const tid = String(threadId);
  if (bridge.externalThreadIds.has(tid)) return true;
  for (const entry of bridge.chatThreads.values()) {
    if (entry?.threadId === tid) return true;
  }
  return false;
}

function registerThreadTarget(bridge: OpenMausBotBridge, targetBot: OmbTargetBot, threadId: string): void {
  if (targetBot.isGroup) {
    bridge.groupByThread.set(threadId, { id: targetBot.id, name: targetBot.name, threadId, isGroup: true });
  } else {
    bridge.botByThread.set(threadId, { id: targetBot.id, name: targetBot.name, threadId });
  }
}

/** 确保自聊回到独立的自聊主线 Thread，防止误连到外群隔离 Thread。 */
export async function resolveSelfBotThread(bridge: OpenMausBotBridge, targetBot: OmbTargetBot): Promise<OmbTargetBot> {
  if (!targetBot) return targetBot;
  if (!isExternalThread(bridge, targetBot.threadId)) {
    setSelfThread(bridge, targetBot);
    return targetBot;
  }
  const saved = bridge.selfThreads.get(String(targetBot.id));
  if (saved?.threadId && !isExternalThread(bridge, saved.threadId)) {
    registerThreadTarget(bridge, targetBot, saved.threadId);
    return { ...targetBot, threadId: saved.threadId };
  }
  if (bridge.focus?.botId === targetBot.id && bridge.focus?.threadId && !isExternalThread(bridge, bridge.focus.threadId)) {
    const next = { ...targetBot, threadId: bridge.focus.threadId };
    registerThreadTarget(bridge, targetBot, bridge.focus.threadId);
    setSelfThread(bridge, next);
    return next;
  }
  try {
    const created = targetBot.isGroup && typeof bridge.client.createGroupTask === 'function'
      ? await bridge.client.createGroupTask(targetBot.id, { title: '自聊主线' })
      : (typeof bridge.client.createTask === 'function'
        ? await bridge.client.createTask(targetBot.id, { title: '自聊主线', select: true })
        : null);
    const newTid = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId;
    if (newTid && !isExternalThread(bridge, newTid)) {
      invalidateBotListCache(bridge);
      registerThreadTarget(bridge, targetBot, newTid);
      const next = { ...targetBot, threadId: newTid };
      setSelfThread(bridge, next);
      return next;
    }
  } catch { /* ignore */ }
  return targetBot;
}

export function setChatThread(bridge: OpenMausBotBridge, chatId: string, targetBot: OmbTargetBot): void {
  if (!chatId || !targetBot?.id || !targetBot?.threadId) return;
  const cid = String(chatId);
  const meta = bridge.externalChatMeta.get(cid);
  const key = `${cid}:${targetBot.id}`;
  bridge.chatThreads.set(key, {
    threadId: targetBot.threadId,
    botId: targetBot.id,
    botName: targetBot.name,
    isGroup: Boolean(targetBot.isGroup),
    chatId: cid,
    chatName: meta?.name || '',
    chatType: meta?.type || 'direct',
  });
  rememberBounded(bridge.externalThreadIds, targetBot.threadId, 500);
  trimMapCap(bridge.chatThreads, 200);
  bridge.saveState();
}

/** 为外部群或私聊绑定并创建隔离的 OpenMausBot Thread（并发同键自动合流）。 */
export async function ensureChatThread(
  bridge: OpenMausBotBridge,
  chatId: string,
  chatType: ChatType,
  chatName: string,
  targetBot: OmbTargetBot,
): Promise<OmbTargetBot> {
  if (!chatId || chatType === 'self' || !targetBot || bridge.chats.isolateThreadsByChat === false) {
    return targetBot;
  }
  const key = `${chatId}:${targetBot.id}`;
  const existing = bridge.chatThreads.get(key);
  if (existing?.threadId) return { ...targetBot, threadId: existing.threadId };
  const inflight = bridge.pendingChatThreads.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<OmbTargetBot> => {
    const title = clip(`${chatType === 'group' ? '群聊' : '私聊'} · ${chatName || chatId}`, 40);
    const createFn = targetBot.isGroup && typeof bridge.client.createGroupTask === 'function'
      ? () => bridge.client.createGroupTask!(targetBot.id, { title })
      : (typeof bridge.client.createTask === 'function'
        ? () => bridge.client.createTask!(targetBot.id, { title, select: false })
        : null);
    if (!createFn) return targetBot;
    let created;
    try {
      created = await createFn();
    } catch (e) {
      throw new Error(`创建外部会话「${chatName || chatId}」隔离上下文失败：${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    const newTid = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId;
    if (!newTid) {
      throw new Error(`创建外部会话「${chatName || chatId}」隔离上下文失败：未返回 threadId`);
    }
    invalidateBotListCache(bridge);
    registerThreadTarget(bridge, targetBot, newTid);
    const nextTarget = { ...targetBot, threadId: newTid };
    setChatThread(bridge, chatId, nextTarget);
    return nextTarget;
  })().finally(() => {
    bridge.pendingChatThreads.delete(key);
  });
  bridge.pendingChatThreads.set(key, task);
  return task;
}
