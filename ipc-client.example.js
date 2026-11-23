/**
 * IM IPC client 示例：复制为项目根目录下的 ipc-client.js，把 TODO 换成你现有的 IPC 调用（4、5 可选）。
 * 在 config.json 中设置：
 *   "transport": "ipc",
 *   "ipc": { "client": "./ipc-client.js", "selfId": "<你在 IM 中的用户 id>" }
 * 字段含义见 src/im/ipc.js 顶部说明。
 */

let ipc; // 你现有的 IPC 连接

export async function connect(onMessage, { onDisconnect } = {}) {
  // TODO 1：建立连接，并订阅所有新消息（包括你自己发出的及各设备同步消息）；断线时通知 onDisconnect 触发自动重连
  // ipc = await yourIpc.connect(...);
  // ipc.on?.('close', (err) => onDisconnect?.(err));
  // ipc.on('message', (raw) => onMessage({
  //   msgId: raw.id,
  //   chatId: raw.conversationId,
  //   chatType: raw.isSelfChat ? 'self' : raw.isGroup ? 'group' : raw.isSystem ? 'system' : 'single',
  //   chatName: raw.conversationName,
  //   fromId: raw.senderId,
  //   fromName: raw.senderName,
  //   fromDevice: { id: raw.deviceId, type: raw.platform === 'ios' || raw.platform === 'android' ? 'mobile' : 'desktop', name: raw.deviceName },
  //   text: raw.content,
  //   atUserIds: raw.atList,
  //   atAll: raw.atAll,
  //   quoteMsgId: raw.quoteId,
  //   time: raw.timestamp,
  //   files: raw.attachments?.map((a) => ({ fileId: a.id, name: a.name, size: a.size, mime: a.mime })),
  // }));
  throw new Error('IPC client 还没实现：请按 ipc-client.example.js 填写 TODO');
}

export async function send({ chatId, text, quoteMsgId }) {
  // TODO 2：以你的账号发送消息，返回新消息 id
  // const r = await ipc.send({ conversationId: chatId, content: text, quoteId: quoteMsgId });
  // return { msgId: r.id };
  throw new Error('not implemented');
}

// 下面两个可选：实现后，长结果可按 .md 附件发到自聊，你从手机发来的截图/日志也可自动传给 OpenMausBot
export async function sendFile({ chatId, filePath, fileName, quoteMsgId }) {
  // TODO 4：上传本地文件并发送，返回 { msgId }
  // const r = await ipc.sendFile({ conversationId: chatId, path: filePath, name: fileName, quoteId: quoteMsgId });
  // return { msgId: r.id };
  throw new Error('not implemented');
}

export async function download({ msgId, fileId, savePath }) {
  // TODO 5：把消息里的文件下载保存到 savePath
  // await ipc.download({ messageId: msgId, fileId, to: savePath });
  throw new Error('not implemented');
}

export async function close() {
  // TODO 3：断开连接
  // await ipc?.close();
}

// 下面三个可选：实现后在任意群/私聊 @bot 时可向真实 IM 拉取更早的引用消息或历史上下文
// export async function getMessage({ chatId, msgId }) {
//   return await ipc.getMessage({ conversationId: chatId, messageId: msgId });
// }
// export async function getHistory({ chatId, limit, beforeMsgId, beforeTs }) {
//   return await ipc.listMessages({ conversationId: chatId, limit, beforeId: beforeMsgId, beforeTime: beforeTs });
// }
// export async function searchHistory({ chatId, query, limit }) {
//   return await ipc.searchMessages({ conversationId: chatId, keyword: query, limit });
// }
