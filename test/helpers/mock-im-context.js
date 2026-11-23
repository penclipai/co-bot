import fs from 'node:fs';
import path from 'node:path';

export function makeMockHarness({ onCreateTask, onSendMessage, onRespond, onExport } = {}) {
  const sentPrompts = [];
  const createdTasks = [];
  const responds = [];
  let seq = 0;

  return {
    sentPrompts,
    createdTasks,
    responds,
    client: {
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
      async resolveBot(name) {
        if (!name || name.toLowerCase() === 'mausbot') {
          return { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' };
        }
        return null;
      },
      async createTask(botId, opts = {}) {
        const tid = `th_ext_${++seq}`;
        createdTasks.push({ botId, threadId: tid, opts });
        onCreateTask?.({ botId, threadId: tid, opts });
        return {
          bot: { id: botId, name: 'MausBot', threadId: 'th_self_main' },
          task: { id: tid, threadId: tid, title: opts.title || '会话' },
        };
      },
      async uploadFile(name, buf, mime) {
        return { path: `/tmp/omb/${name}`, size: buf.length, mime };
      },
      async uploadImage(buf, mime) {
        return { path: '/tmp/omb/img.png', size: buf.length, mime };
      },
      async sendMessage(botId, payload) {
        const entry = { botId, ...payload };
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
      async respond(threadId, payload) {
        responds.push({ threadId, ...payload });
        return onRespond ? onRespond({ threadId, ...payload }) : { ok: true };
      },
      async exportThread(threadId) {
        return onExport ? onExport(threadId) : { name: 'ext.md', text: '# Exported thread' };
      },
      async subscribeEvents(_cb, { signal } = {}) {
        if (!signal) return new Promise(() => {});
        if (signal.aborted) return;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  };
}

export function makeMockTransport(downloads = {}) {
  const sent = [];
  const sentFiles = [];
  let n = 0;
  let handler = null;
  return {
    sent,
    sentFiles,
    transport: {
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
      async send(chatId, text, opts = {}) {
        const id = `im_out_${++n}`;
        sent.push({ id, chatId, text, opts });
        return id;
      },
      async sendFile(chatId, file, opts = {}) {
        const id = `im_file_${++n}`;
        sentFiles.push({ id, chatId, file, opts });
        return id;
      },
      async download(att, savePath) {
        const content = downloads[att.id] ?? `mock:${att.name}`;
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, content);
      },
      async stop() {},
      emit(ev) { return handler?.(ev); },
    },
  };
}
