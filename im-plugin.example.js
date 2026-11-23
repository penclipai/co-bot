/**
 * 通用 IM 通道插件示例（支持本地 IM IPC，也可作为飞书 / 企微 / 钉钉 / Telegram 适配模板）：
 *
 * 使用方法：
 *   1. 复制为根目录下的 im-plugin.js（已在 .gitignore 忽略，不入库）
 *   2. 在 TODO 处接入你现有的本地 IM IPC 收发方法（与底层协议解耦）
 *   3. 在 config.json 中配置：
 *      {
 *        "channel": {
 *          "use": "./im-plugin.js",
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
import { defineChannelPlugin } from './src/core/channel-contract.js';

export default defineChannelPlugin({
  name: 'custom-im',
  version: '1.0.0',

  // 按目标 IM 真实能力声明即可；co-bot 会自动降级纯文本/字数上限/按钮与附件
  capabilities: {
    markdown: true,    // false 时 co-bot 自动剥离 Markdown 格式改发干净纯文本
    files: true,       // false 时不尝试发 .md / 文件附件
    images: true,      // false 时不回传截图/图片
    replyTo: true,     // false 时忽略引用气泡参数
    actions: false,    // 真实 IM 无模拟器内嵌按钮时保持 false
    history: false,    // 实现下方可选 getMessage / getHistory / searchHistory 后设为 true
    notify: false,     // 若“自聊消息”无手机推送，实现下方 notify() 后设为 true
    maxChars: 0,       // 单条字符上限，如企微/短信限 2000，0 表示沿用 selfChat.resultChars
    multiDevice: true, // 是否透传手机/桌面多端来源，配合 commandDevices 过滤
  },

  create(options, ctx) {
    let ipc = null;

    return {
      /**
       * 建立 IM 连接，并把收到的消息推给 onEvent；连接意外断开时调用 onDisconnect(err)，
       * 内核托管层会自动按指数退避重连，并在自聊消息到达时自动学习 selfChatId。
       */
      async start(onEvent, { onDisconnect }) {
        // 示例：接入你的 IM IPC SDK
        // ipc = await yourIpc.connect({ selfId: options.selfId });
        // ipc.on('close', (err) => onDisconnect?.(err));
        // ipc.on('message', (raw) => {
        //   // 支持直接传标准 InboundEvent，或传如下通用扁平结构（内核自动归一化）：
        //   onEvent({
        //     msgId: raw.id,
        //     chatId: raw.conversationId,
        //     chatType: raw.isSelfChat ? 'self' : raw.isGroup ? 'group' : 'single',
        //     chatName: raw.conversationName,
        //     fromId: raw.senderId,
        //     fromName: raw.senderName,
        //     fromDevice: {
        //       id: raw.deviceId,
        //       type: raw.platform === 'ios' || raw.platform === 'android' ? 'mobile' : 'desktop',
        //       name: raw.deviceName,
        //     },
        //     text: raw.content,
        //     quoteMsgId: raw.quoteId,
        //     time: raw.timestamp,
        //     files: raw.attachments?.map((a) => ({
        //       fileId: a.id, name: a.name, size: a.size, mime: a.mime,
        //     })),
        //   });
        // });
        void ctx;
        void onEvent;
        void onDisconnect;
        throw new Error('im-plugin 尚未填写 TODO（参考 im-plugin.example.js）');
      },

      async send(chatId, text, { replyTo } = {}) {
        // const res = await ipc.send({ conversationId: chatId, content: text, quoteId: replyTo });
        // return String(res.id);
        void chatId;
        void text;
        void replyTo;
        void ipc;
        throw new Error('send not implemented');
      },

      async sendFile(chatId, { path: filePath, name }, { replyTo } = {}) {
        // const res = await ipc.sendFile({ conversationId: chatId, path: filePath, name, quoteId: replyTo });
        // return String(res.id);
        void chatId;
        void filePath;
        void name;
        void replyTo;
        throw new Error('sendFile not implemented');
      },

      async download(att, savePath) {
        // await ipc.download({ messageId: att.msgId, fileId: att.id, to: savePath });
        void att;
        void savePath;
        throw new Error('download not implemented');
      },

      // 以下三个可选：实现后当用户在群里引用较早消息或 Bot 需拉取更早上下文时可突破内存缓存回溯 IM 历史
      // async getMessage(chatId, msgId) {
      //   return await ipc.getMessage({ conversationId: chatId, messageId: msgId });
      // },
      // async getHistory(chatId, { limit = 30, beforeMsgId, beforeTs } = {}) {
      //   return await ipc.listMessages({ conversationId: chatId, limit, beforeId: beforeMsgId, beforeTime: beforeTs });
      // },
      // async searchHistory(chatId, query, { limit = 10 } = {}) {
      //   return await ipc.searchMessages({ conversationId: chatId, keyword: query, limit });
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
