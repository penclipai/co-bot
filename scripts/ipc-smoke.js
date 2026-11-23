#!/usr/bin/env node
/**
 * IM IPC 联调冒烟测试脚本（npm run ipc:smoke）：
 *   node scripts/ipc-smoke.js [--config config.json] [--wait 15] [--send "测试消息"] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { IpcTransport } from '../src/im/ipc.js';
import { resolveChannelSpec } from '../src/plugins/channel-loader.js';
import { runChannelContractTest } from './channel-test.js';

function parseArgs(argv) {
  let configFile;
  let waitSec = 15;
  let sendText = '';
  let dry = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--dry') { dry = true; continue; }
    if (a === '--config' && argv[i + 1]) { configFile = argv[++i]; continue; }
    if (a === '--wait' && argv[i + 1]) { waitSec = Math.max(0, Number(argv[++i]) || 0); continue; }
    if (a === '--send' && argv[i + 1]) { sendText = String(argv[++i]); continue; }
  }
  return { configFile, waitSec, sendText, dry, help };
}

function usage() {
  console.log([
    '用法：npm run ipc:smoke -- [--config config.json] [--wait 15] [--send "你好"] [--dry]',
    '  --dry     仅检查 ipc.client 导出契约，不实际建立 IPC 长连接',
    '  --wait N  最多等待 N 秒接收自聊消息（默认 15s）',
    '  --send T  当 selfChatId 已知或学到后，发送一条测试消息到自聊会话',
  ].join('\n'));
}

async function main() {
  const { configFile, waitSec, sendText, dry, help } = parseArgs(process.argv.slice(2));
  if (help) { usage(); return; }

  const cfg = loadConfig(process.argv.slice(2), configFile);
  const chanSpec = resolveChannelSpec(cfg);
  if (chanSpec.kind === 'external' && (!cfg.ipc.client || !fs.existsSync(cfg.ipc.client))) {
    const res = await runChannelContractTest(cfg, { dry, waitSec, sendText });
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!cfg.ipc.selfId) throw new Error('config.json 的 ipc.selfId 未填写');
  if (!cfg.ipc.client || !fs.existsSync(cfg.ipc.client)) {
    throw new Error(`找不到 ipc.client：${cfg.ipc.client || '(未填写)'}`);
  }

  const mod = await import(pathToFileURL(path.resolve(cfg.ipc.client)).href);
  const exportsOk = typeof mod.connect === 'function' && typeof mod.send === 'function';
  if (!exportsOk) throw new Error(`${cfg.ipc.client} 必须导出 connect 与 send 函数`);
  console.log(`✓ IPC 模块导出校验通过（sendFile: ${typeof mod.sendFile === 'function'}, download: ${typeof mod.download === 'function'}, close: ${typeof mod.close === 'function'}）`);
  if (dry) return;

  const ipc = new IpcTransport({ ...cfg.ipc, clientModule: mod });
  let sentDone = false;
  let resolveWait;
  const waitDone = new Promise((r) => { resolveWait = r; });

  await ipc.start(async (ev) => {
    console.log(`← 收到事件 id=${ev.id} chat=${ev.chat.type}:${ev.chat.id} self=${ev.sender.isSelf} dev=${ev.device?.type || '-'} text=${JSON.stringify(ev.text)} atts=${ev.attachments?.length ?? 0}`);
    if (sendText && !sentDone && ipc.selfChatId) {
      sentDone = true;
      const mid = await ipc.send(ipc.selfChatId, sendText);
      console.log(`→ 已回发测试消息 msgId=${mid ?? 'unknown'}`);
      resolveWait();
    } else if (!sendText && ev.chat.type === 'self') {
      resolveWait();
    }
  });

  try {
    console.log('✓ IPC 已连接：', JSON.stringify(ipc.status()));
    if (sendText && ipc.selfChatId && !sentDone) {
      sentDone = true;
      const mid = await ipc.send(ipc.selfChatId, sendText);
      console.log(`→ 已发送测试消息 msgId=${mid ?? 'unknown'}`);
    } else if (waitSec > 0) {
      console.log(`⏳ 等待 ${waitSec}s 接收自聊消息（可在手机自聊发一条消息验证回流）…`);
      let timer;
      await Promise.race([
        waitDone,
        new Promise((r) => { timer = setTimeout(r, waitSec * 1000); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
    }
  } finally {
    await ipc.stop();
  }
}

main().catch((e) => {
  console.error(`✗ ipc:smoke 失败：${e.message}`);
  process.exitCode = 1;
});
