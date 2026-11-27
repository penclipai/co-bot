/**
 * 通用 IM 通道插件示例（支持本地 IM IPC，也可作为飞书 / 企微 / 钉钉 / Telegram 适配模板）：
 *
 * 使用方法：
 *   1. 复制为根目录下的 im-plugin.ts（或 im-plugin.js，均已在 .gitignore 忽略，不入库）
 *   2. 在 TODO 处接入你现有的本地 IM IPC 收发方法（与底层协议解耦）
 *   3. 在 config.json 中配置：
 *      {
 *        "channel": {
 *          "use": "./im-plugin.ts",
 *          "options": {
 *            "selfId": "<你在 IM 的用户 id>",
 *            "selfChatId": ""
 *          }
 *        }
 *      }
 *   4. 运行契约自检与收发联调：
 *      npm run channel:test -- --dry
 *      npm run channel:test -- --wait 15 --send "hello" --check-file
 */
import {
  createInboundMessage,
  createRecallEvent,
  decodeScopedChatId,
  defineChannelPlugin,
  encodeScopedChatId,
} from './src/core/channel-contract.ts';
import type {
  ChannelDownloadContext,
  ChannelSendFileInput,
  ChannelSendOptions,
  ChannelStartContext,
  InboundAttachment,
} from './src/types.ts';

interface CustomImOptions extends Record<string, unknown> {
  selfId?: string;
  selfChatId?: string;
  strictContract?: boolean;
}

export default defineChannelPlugin<CustomImOptions>({
  name: 'custom-im',
  version: '1.0.0',

  // 可选：按目标 IM 声明真实 ID 格式护栏（例如 userId: /^u_/, chatId: /^(?:self|dm|grp):/）
  // 一旦不小心把昵称/openId/群ID 传混，入站/出站/白名单配置都会立即拦截报错
  idPatterns: {
    // userId: /^[A-Za-z0-9_-]+$/,
    // chatId: /^(?:self|dm|grp|sys):.+$/,
  },
  // strictContract: true,

  // 按目标 IM 真实能力声明即可；co-bot 会自动降级纯文本/字数上限/按钮与附件
  capabilities: {
    markdown: true,    // false 时 co-bot 自动剥离 Markdown 格式改发干净纯文本
    files: true,       // false 时不尝试发 .md / 文件附件
    images: true,      // false 时不回传截图/图片
    replyTo: true,     // false 时忽略引用气泡参数
    actions: false,    // 真实 IM 建议保持 false，co-bot 统一发 Markdown 伪卡片
    history: false,    // 实现下方可选 getMessage / getHistory 后设为 true
    notify: false,     // 若“自聊消息”无手机推送，实现下方 notify() 后设为 true
    maxChars: 0,       // 单条字符上限，如企微/短信限 2000，0 表示沿用 selfChat.resultChars
    multiDevice: true, // 是否透传手机/桌面多端来源，配合 commandDevices 过滤
  },

  create(options, ctx) {
    let ipc: { close?: () => Promise<void> | void } | null = null;
    void encodeScopedChatId;
    void decodeScopedChatId;
    void createInboundMessage;
    void createRecallEvent;

    return {
      /**
       * 建立 IM 连接，并把收到的消息推给 onEvent；连接意外断开时调用 onDisconnect(err)，
       * 内核托管层会自动按指数退避重连，并在自聊消息到达时自动学习 selfChatId。
       */
      async start(onEvent: (raw: unknown) => void, { onDisconnect }: ChannelStartContext) {
        // 强烈推荐使用 createInboundMessage / createRecallEvent + encodeScopedChatId：
        // 若底层 IM 的单聊 userId 与群聊 groupId 同为数字容易撞号，使用 encodeScopedChatId('direct' | 'group' | 'self', rawId) 隔离！
        //
        // ipc = await yourIpc.connect({ selfId: options.selfId });
        // ipc.on('close', (err) => onDisconnect?.(err));
        // ipc.on('message', (raw) => {
        //   const chatType = raw.isSelfChat ? 'self' : raw.isGroup ? 'group' : 'direct';
        //   const chatId = encodeScopedChatId(chatType, String(raw.conversationId));
        //   const selfId = String(options.selfId || '');
        //   onEvent(createInboundMessage({
        //     id: String(raw.id),
        //     ts: Number(raw.timestamp),
        //     chat: { id: chatId, type: chatType, name: raw.conversationName },
        //     sender: {
        //       id: String(raw.senderId), // 注意：64位雪花ID务必保持 string
        //       name: raw.senderName,
        //       isSelf: Boolean(selfId && String(raw.senderId) === selfId),
        //     },
        //     device: {
        //       id: String(raw.deviceId || ''),
        //       type: raw.platform === 'ios' || raw.platform === 'android' ? 'mobile' : 'desktop',
        //       name: raw.deviceName,
        //     },
        //     text: String(raw.content ?? ''),
        //     // 结构化引用快照：即使 getMessage 未命中或历史过久，也能让 Bot 看到被引用人与原话
        //     ...(raw.quote ? {
        //       replyTo: String(raw.quote.id),
        //       quote: {
        //         msgId: String(raw.quote.id),
        //         senderId: raw.quote.senderId ? String(raw.quote.senderId) : undefined,
        //         senderName: raw.quote.senderName,
        //         text: raw.quote.content,
        //         ts: raw.quote.timestamp,
        //       },
        //     } : {}),
        //     // 结构化 @提及：务必填平台真实 userId，不要把昵称充当 id
        //     mentions: raw.atUsers?.map((u) => ({ id: String(u.userId), name: u.name, isAll: Boolean(u.isAll) })),
        //     attachments: raw.attachments?.map((a) => ({
        //       id: String(a.id),
        //       msgId: String(raw.id),
        //       chatId,
        //       name: a.name,
        //       size: a.size,
        //       mime: a.mime,
        //       extra: { fileKey: a.fileKey, aesKey: a.aesKey }, // 仅传给 download()，不会外泄
        //     })),
        //   }, { selfId, selfChatId: options.selfChatId }));
        // });
        void options;
        void ctx;
        void onEvent;
        void onDisconnect;
        throw new Error('im-plugin 尚未填写 TODO（参考 im-plugin.example.ts）');
      },

      async send(chatId: string, text: string, { chatType, replyTo, mentions }: ChannelSendOptions = {}) {
        // const target = decodeScopedChatId(chatId); // { type: 'direct' | 'group', rawId }
        // const res = await ipc.send({ chatType: chatType ?? target?.type, targetId: target?.rawId ?? chatId, content: text, quoteId: replyTo, atUsers: mentions });
        // return String(res.id);
        void chatId;
        void chatType;
        void text;
        void replyTo;
        void mentions;
        void ipc;
        throw new Error('send not implemented');
      },

      async sendFile(chatId: string, { path: filePath, name }: ChannelSendFileInput, { chatType, replyTo }: ChannelSendOptions = {}) {
        // const target = decodeScopedChatId(chatId);
        // const res = await ipc.sendFile({ chatType: chatType ?? target?.type, targetId: target?.rawId ?? chatId, path: filePath, name, quoteId: replyTo });
        // return String(res.id);
        void chatId;
        void chatType;
        void filePath;
        void name;
        void replyTo;
        throw new Error('sendFile not implemented');
      },

      async download(att: InboundAttachment, savePath: string, dlCtx?: ChannelDownloadContext) {
        // await ipc.download({ chatId: dlCtx?.chatId ?? att.chatId, chatType: dlCtx?.chatType, messageId: att.msgId, fileId: att.id, extra: att.extra, to: savePath });
        void att;
        void savePath;
        void dlCtx;
        throw new Error('download not implemented');
      },

      // 以下两个可选：实现后当用户在群里引用较早消息或 Bot 需拉取更早上下文时可突破内存缓存回溯 IM 历史
      // async getMessage(chatId: string, msgId: string, opts?: ChannelGetMessageOptions) {
      //   return await ipc.getMessage({ conversationId: chatId, chatType: opts?.chatType, messageId: msgId });
      // },
      // async getHistory(chatId: string, { chatType, limit = 30, beforeMsgId, beforeTs }: ChannelGetHistoryOptions = {}) {
      //   return await ipc.listMessages({ conversationId: chatId, chatType, limit, beforeId: beforeMsgId, beforeTime: beforeTs });
      // },

      // 可选：当“发给自己的自聊消息”手机端不推送提醒时，实现 notify() 补发应用通知
      // async notify({ title, body, chatId, urgent }) {
      //   await ipc.pushNotification({ title, body, chatId, urgent });
      // },

      async stop() {
        await ipc?.close?.();
        ipc = null;
      },
    };
  },
});
