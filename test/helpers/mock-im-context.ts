import fs from 'node:fs';
import path from 'node:path';
import type { OpenMausBotClient } from '../../src/openmausbot/client.ts';
import type { BridgeTransport } from '../../src/openmausbot/types.ts';
import type { ChannelSendFileInput, ChannelSendOptions, InboundAttachment, InboundEvent } from '../../src/types.ts';

export interface MockHarnessHooks {
  onCreateTask?: (info: { botId: string; threadId: string; opts: Record<string, unknown> }) => void;
  onSendMessage?: (entry: Record<string, unknown>) => unknown;
  onRespond?: (entry: Record<string, unknown>) => unknown;
}

export interface SentPromptRecord extends Record<string, unknown> {
  botId: string;
  threadId?: string;
  text?: string;
  sendId?: string;
  attachments?: unknown[];
}

export function makeMockHarness({ onCreateTask, onSendMessage, onRespond }: MockHarnessHooks = {}) {
  const sentPrompts: SentPromptRecord[] = [];
  const createdTasks: Array<{ botId: string; threadId: string; opts: Record<string, unknown> }> = [];
  const responds: Array<Record<string, unknown>> = [];
  let seq = 0;

  const client = {
    baseUrl: 'http://127.0.0.1:8799',
    async health() { return { ok: true, version: '0.1.173', box: 'off' }; },
    async listBots() {
      return {
        bots: [{
          id: 'bot_main',
          name: 'MausBot',
          chiefOfStaff: true,
          threadId: 'th_self_main',
          mainThreadId: 'th_self_main',
          tasks: [{ id: 'th_self_main', threadId: 'th_self_main', title: '自聊主线' }],
        }],
        groups: [],
      };
    },
    async resolveBot(name?: string) {
      if (!name || name.toLowerCase() === 'mausbot') {
        return { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' };
      }
      return null;
    },
    async createTask(botId: string, opts: { title?: string } = {}) {
      const tid = `th_ext_${++seq}`;
      createdTasks.push({ botId, threadId: tid, opts });
      onCreateTask?.({ botId, threadId: tid, opts });
      return {
        bot: { id: botId, name: 'MausBot', threadId: 'th_self_main' },
        task: { id: tid, threadId: tid, title: opts.title || '会话' },
      };
    },
    async uploadFile(name: string, buf: Uint8Array, mime?: string) {
      return { path: `/tmp/omb/${name}`, size: buf.length, mime };
    },
    async uploadImage(buf: Uint8Array, mime?: string) {
      return { path: '/tmp/omb/img.png', size: buf.length, mime };
    },
    async sendMessage(botId: string, payload: Record<string, unknown>) {
      const entry: SentPromptRecord = { botId, ...payload };
      sentPrompts.push(entry);
      if (onSendMessage) return onSendMessage(entry);
      return { message: { id: `req_${++seq}` } };
    },
    async getMessages() {
      return { messages: [] };
    },
    async getJob() {
      return { state: 'idle', since: 1, version: 1 };
    },
    async respond(threadId: string, payload: Record<string, unknown>) {
      responds.push({ threadId, ...payload });
      return onRespond ? onRespond({ threadId, ...payload }) : { ok: true };
    },
    async subscribeEvents(_cb: unknown, { signal }: { signal?: AbortSignal } = {}) {
      if (!signal) return new Promise<void>(() => {});
      if (signal.aborted) return;
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };

  return {
    sentPrompts,
    createdTasks,
    responds,
    client: client as unknown as OpenMausBotClient,
  };
}

export function makeMockTransport(downloads: Record<string, string | Buffer> = {}) {
  const sent: Array<{ id: string; chatId: string; text: string; opts: ChannelSendOptions }> = [];
  const sentFiles: Array<{ id: string; chatId: string; file: ChannelSendFileInput; opts: ChannelSendOptions }> = [];
  let n = 0;
  let handler: ((ev: InboundEvent) => unknown) | null = null;
  const transport: BridgeTransport & { emit: (ev: InboundEvent) => unknown } = {
    selfChatId: 'chat_self',
    capabilities: {
      markdown: true,
      files: true,
      images: true,
      replyTo: true,
      actions: true,
      history: false,
    },
    async start(fn) { handler = fn; },
    async send(chatId: string, text: string, opts: ChannelSendOptions = {}) {
      const id = `im_out_${++n}`;
      sent.push({ id, chatId, text, opts });
      return id;
    },
    async sendFile(chatId: string, file: ChannelSendFileInput, opts: ChannelSendOptions = {}) {
      const id = `im_file_${++n}`;
      sentFiles.push({ id, chatId, file, opts });
      return id;
    },
    async download(att: InboundAttachment, savePath: string) {
      const content = downloads[att.id] ?? `mock:${att.name}`;
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, content);
    },
    async stop() {},
    emit(ev: InboundEvent) { return handler?.(ev); },
  };
  return { sent, sentFiles, transport };
}
