import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.ts';
import { CommandRegistry } from '../src/core/extensions.ts';
import { definePlugin, Kernel, parseInject } from '../src/core/kernel.ts';
import { discoverPlugins, resolvePluginConfig } from '../src/core/plugin-loader.ts';
import { listCustomRedactors, scanAndRedactOutbound } from '../src/core/security.ts';
import { createApp } from '../src/index.ts';
import { loadChannelPlugin } from '../src/plugins/channel-loader.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { runChannelContractTest } from '../scripts/channel-test.ts';
import type {
  CommandRegistryService,
  HooksExtensionService,
  KernelPluginStatus,
  SecurityExtensionService,
} from '../src/types.ts';

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

async function startMinimalMockOmb(onPrompt?: (text: string) => string) {
  let seq = 1;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && u.pathname === '/api/health') {
      return json(200, { app: 'openmausbot', version: '0.1.180-mock', box: 'off' });
    }
    if (req.method === 'GET' && u.pathname === '/.well-known/openmausbot/environment') {
      return json(200, { capabilities: { selfUpdate: 'operator' } });
    }
    if (req.method === 'GET' && u.pathname === '/api/auth/session') {
      return json(200, { kind: 'none', scopes: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/bots') {
      return json(200, { bots: [{ id: 'b1', name: 'co-bot', threadId: 't1', chiefOfStaff: true }], groups: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello","cursor":"1"}\n\n');
      req.on('close', () => res.end());
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/bots/b1/uploads') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return json(200, { path: `/mock/upload_${seq++}.bin` });
    }
    if (req.method === 'POST' && u.pathname === '/api/bots/b1/messages') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text: string; sendId: string };
      const replyText = onPrompt ? onPrompt(body.text) : `ok: ${body.text}`;
      const msgId = `u_${seq++}`;
      const replyId = `b_${seq++}`;
      serverMessages.push({
        id: replyId,
        role: 'bot',
        kind: 'text',
        threadId: 't1',
        requestMessageId: msgId,
        text: replyText,
        turnTerminal: true,
      });
      return json(202, {
        ok: true,
        threadId: 't1',
        message: { id: msgId, role: 'user', kind: 'text', threadId: 't1', text: body.text, sendId: body.sendId },
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/threads/t1/job') {
      return json(200, { state: 'completed', version: `v_${seq}`, needsInput: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/threads/t1/messages') {
      return json(200, { messages: [...serverMessages] });
    }
    json(404, { error: 'not found' });
  });
  const serverMessages: Array<Record<string, unknown>> = [];
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('Phase 1: Kernel optional inject, isolated plugin failure containment, and runtime mount/unmount/reload', async () => {
  assert.deepEqual(parseInject('a'), { required: ['a'], optional: [] });
  assert.deepEqual(parseInject({ required: ['a'], optional: ['b'] }), { required: ['a'], optional: ['b'] });

  const order: string[] = [];
  const disposed: string[] = [];
  const k = new Kernel({ logger: { warn() {}, error() {} } });

  k.use(definePlugin({
    name: 'consumer',
    kind: 'extension',
    source: '/tmp/consumer.ts',
    inject: { required: ['coreSvc'], optional: ['optSvc', 'missingOpt'] },
    apply(ctx) {
      order.push(`consumer(opt=${ctx.has('optSvc')},missing=${ctx.has('missingOpt')})`);
      ctx.effect(() => disposed.push('consumer'));
    },
  }));
  k.use({
    name: 'optProvider',
    provides: ['optSvc'],
    apply(ctx) {
      order.push('optProvider');
      ctx.provide('optSvc', true);
    },
  });
  k.use({
    name: 'coreProvider',
    provides: ['coreSvc'],
    apply(ctx) {
      order.push('coreProvider');
      ctx.provide('coreSvc', true);
    },
  });
  k.use({
    name: 'broken-isolated',
    kind: 'extension',
    source: '/tmp/broken.ts',
    isolated: true,
    inject: ['nonExistentDep'],
    apply() {},
  });
  k.use({
    name: 'boom-isolated',
    kind: 'extension',
    source: '/tmp/boom.ts',
    isolated: true,
    apply() { throw new Error('plugin init boom'); },
  });

  await k.start();
  assert.deepEqual(order, ['optProvider', 'coreProvider', 'consumer(opt=true,missing=false)']);

  const st = k.status().plugins;
  assert.equal(st.find((p) => p.name === 'broken-isolated')?.error?.includes('缺少依赖服务'), true);
  assert.equal(st.find((p) => p.name === 'boom-isolated')?.error, 'plugin init boom');
  assert.equal(st.find((p) => p.name === 'consumer')?.reloadable, true);
  assert.equal(st.find((p) => p.name === 'coreProvider')?.reloadable, false);

  await k.mount({
    name: 'dyn',
    kind: 'extension',
    source: '/tmp/dyn.ts',
    provides: ['dynSvc'],
    apply(ctx) {
      ctx.provide('dynSvc', 'v1');
      ctx.effect(() => disposed.push('dyn-v1'));
    },
  });
  assert.equal(k.get('dynSvc'), 'v1');

  await k.reload('dyn', {
    name: 'dyn',
    kind: 'extension',
    source: '/tmp/dyn.ts',
    provides: ['dynSvc'],
    apply(ctx) {
      ctx.provide('dynSvc', 'v2');
      ctx.effect(() => disposed.push('dyn-v2'));
    },
  });
  assert.equal(k.get('dynSvc'), 'v2');
  assert.ok(disposed.includes('dyn-v1'));

  await k.unmount('dyn');
  assert.equal(k.has('dynSvc'), false);
  assert.ok(disposed.includes('dyn-v2'));

  await k.stop();
  assert.ok(disposed.includes('consumer'));

  const reg = new CommandRegistry();
  assert.throws(() => reg.register({ name: 'status', handler() {} }), /内置命令冲突/);
});

test('Phase 2: discoverPlugins scans files & subdirs, honors ignores/config/auto channel, and validates via channel-test', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-plugins-p2-'));
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(path.join(pluginsDir, 'sub-im'), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, 'pkg-im'), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, '.hidden-dir'), { recursive: true });

  const contractUrl = pathToFileURL(path.resolve('src/core/channel-contract.ts')).href;

  try {
    fs.writeFileSync(path.join(pluginsDir, 'README.md'), '# ignore\n');
    fs.writeFileSync(path.join(pluginsDir, '_template.ts'), 'export const name = "ignored"; export function apply() {}\n');
    fs.writeFileSync(path.join(pluginsDir, 'types.d.ts'), 'export type X = string;\n');
    fs.writeFileSync(path.join(pluginsDir, 'sample.test.ts'), 'export const bad = 1;\n');
    fs.writeFileSync(path.join(pluginsDir, '.hidden-dir', 'index.ts'), 'export const name = "hidden"; export function apply() {}\n');

    fs.writeFileSync(path.join(pluginsDir, 'cordis-ext.ts'), `
export const name = 'cordis-ext';
export const version = '1.2.3';
export function apply() {}
`);
    fs.writeFileSync(path.join(pluginsDir, 'broken-syntax.mjs'), 'export const = invalid;;;');
    fs.writeFileSync(path.join(pluginsDir, 'sub-im', 'index.ts'), `
import { defineChannelPlugin } from ${JSON.stringify(contractUrl)};
export default defineChannelPlugin({
  name: 'sub-im',
  capabilities: { markdown: true, files: false, images: false },
  create() {
    return {
      async start() {},
      async send() { return 'ok'; },
      async stop() {},
    };
  },
});
`);

    const discovered1 = await discoverPlugins(pluginsDir, { logger: { warn() {} } });
    assert.deepEqual(discovered1.extensions.map((p) => p.name), ['cordis-ext']);
    assert.deepEqual([...discovered1.channels.keys()], ['sub-im']);
    assert.equal(discovered1.errors.length, 1);
    assert.equal(discovered1.errors[0].name, 'broken-syntax');

    // channel.use = 'auto' with exactly 1 channel picks sub-im
    const pickedAuto = await loadChannelPlugin({ channel: { use: 'auto', options: {} }, pluginsDir });
    assert.equal(pickedAuto.resolvedName, 'sub-im');

    // Named channel lookup picks sub-im without relative path
    const pickedNamed = await loadChannelPlugin({
      channel: { use: 'sub-im', options: { selfId: 'u1' } },
      pluginsDir,
      plugins: { 'sub-im': { enabled: true, customFlag: 42 } },
    });
    assert.equal(pickedNamed.resolvedName, 'sub-im');
    assert.equal(pickedNamed.options.selfId, 'u1');
    assert.equal(pickedNamed.options.customFlag, 42);

    // Contract test CLI helper works with named channel inside pluginsDir
    const dryRes = await runChannelContractTest(
      { pluginsDir, channel: { use: 'sub-im', options: {} }, web: { host: '127.0.0.1', port: 0 } },
      { dry: true, log: () => {} },
    );
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.channelName, 'sub-im');

    // Adding a second channel makes 'auto' error explicitly
    fs.writeFileSync(path.join(pluginsDir, 'pkg-im', 'package.json'), JSON.stringify({ main: './entry.mjs' }));
    fs.writeFileSync(path.join(pluginsDir, 'pkg-im', 'entry.mjs'), `
export const name = 'pkg-im';
export const kind = 'channel';
export const capabilities = { markdown: false };
export function create() {
  return {
    async start() {},
    async send() { return 'ok'; },
    async stop() {},
  };
}
`);
    await assert.rejects(
      () => loadChannelPlugin({ channel: { use: 'auto', options: {} }, pluginsDir }),
      /发现多个通道插件/,
    );

    // Duplicate name detection across files in pluginsDir
    fs.writeFileSync(path.join(pluginsDir, 'dup.ts'), 'export const name = "cordis-ext"; export function apply() {}');
    await assert.rejects(() => discoverPlugins(pluginsDir, { logger: { warn() {} } }), /重名插件「cordis-ext」/);

    // Config validation & plugin toggle parsing
    const vBad = validateConfig({ plugins: { a: 'bad' } });
    assert.equal(vBad.ok, false);
    const vGood = validateConfig({ pluginsDir: './plugins', pluginsStrict: false, plugins: { 'cordis-ext': false } });
    assert.equal(vGood.ok, true);
    assert.deepEqual(resolvePluginConfig({ plugins: { 'cordis-ext': false } }, 'cordis-ext'), { enabled: false, options: {} });
    assert.deepEqual(
      resolvePluginConfig({ plugins: { 'cordis-ext': { enabled: true, foo: 'bar' } } }, 'cordis-ext'),
      { enabled: true, options: { foo: 'bar' } },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 3 & 4 E2E: drop-in plugins register commands/redactor/audio hook and hot-reload cleanly via /api/debug/action', async () => {
  const omb = await startMinimalMockOmb((prompt) => {
    if (prompt.includes('leak')) return 'leak EMP_INT_99887766 done';
    return `echo:${prompt}`;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-plugins-e2e-'));
  const pluginsDir = path.join(root, 'plugins');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const pingFile = path.join(pluginsDir, 'ping-ext.ts');
  const redactorFile = path.join(pluginsDir, 'redactor-ext.ts');
  const voiceFile = path.join(pluginsDir, 'voice-ext.ts');
  const badCommandFile = path.join(pluginsDir, 'bad-cmd-ext.ts');

  fs.writeFileSync(pingFile, `
export const name = 'ping-ext';
export const inject = ['commands'];
export function apply(ctx, opts) {
  const commands = ctx.get('commands');
  commands.register({
    name: 'ping',
    description: '插件存活探针',
    async handler(cmd) {
      await cmd.reply('pong-v1:' + (opts.suffix || 'base') + ':' + (cmd.args || 'none'));
    },
  });
}
`);

  fs.writeFileSync(redactorFile, `
export const name = 'redactor-ext';
export const inject = ['security'];
export function apply(ctx) {
  const security = ctx.get('security');
  security.registerRedactor({
    name: 'emp_int_secret',
    pattern: /\\bEMP_INT_[0-9]{8}\\b/g,
  });
}
`);

  fs.writeFileSync(voiceFile, `
export const name = 'voice-ext';
export const inject = ['hooks'];
export function apply(ctx) {
  const hooks = ctx.get('hooks');
  hooks.registerAudioTranscriber(async (filePath, att) => '转写:' + (att.name || filePath));
}
`);

  // Attempt to override reserved built-in command 'stop' -> must fail & isolate without stopping app
  fs.writeFileSync(badCommandFile, `
export const name = 'bad-cmd-ext';
export const inject = ['commands'];
export function apply(ctx) {
  ctx.get('commands').register({ name: 'stop', async handler() {} });
}
`);

  const cfgPath = path.join(root, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    openmausbot: { url: omb.baseUrl, autoStart: false, cliComputerOff: false, syncChiefIdentity: false },
    channel: { use: 'sim', options: {} },
    web: { host: '127.0.0.1', port: 0 },
    selfChat: { trigger: '@bot', fileRetentionDays: 0, stateSaveDebounceMs: 0, imageBatchMs: 50 },
    pluginsDir: './plugins',
    plugins: {
      'ping-ext': { enabled: true, suffix: 'cfg' },
    },
    dataDir: './data',
  }));

  const cfg = loadConfig([], cfgPath);
  const { kernel } = await createApp(cfg);

  try {
    await kernel.start();
    const web = kernel.get<{ server: http.Server | null }>('web');
    const webPort = (web.server!.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${webPort}`;

    const sim = kernel.get<WebSimTransport>('channel');
    const sendSim = async (text: string, replyTo: string | null = null) => {
      const res = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'self', text, ...(replyTo ? { replyTo } : {}) }),
      });
      assert.equal(res.status, 200);
      return res.json() as Promise<{ ok: boolean; id: string }>;
    };

    // 1. /api/status exposes all plugins with source, reloadable & isolated error
    const st1 = await fetch(`${baseUrl}/api/status`).then((r) => r.json()) as {
      plugins: KernelPluginStatus[];
    };
    const pingMeta = st1.plugins.find((p) => p.name === 'ping-ext')!;
    const badMeta = st1.plugins.find((p) => p.name === 'bad-cmd-ext')!;
    const simMeta = st1.plugins.find((p) => p.name === 'sim')!;
    assert.equal(pingMeta.active, true);
    assert.equal(pingMeta.reloadable, true);
    assert.equal(simMeta.reloadable, false);
    assert.equal(badMeta.active, false);
    assert.match(String(badMeta.error), /内置命令冲突/);

    // /debug HTML shows plugin table with source + reload action column
    const dbgHtml = await fetch(`${baseUrl}/debug`).then((r) => r.text());
    assert.match(dbgHtml, /<th>来源<\/th>[\s\S]*<th>操作<\/th>/);
    assert.match(dbgHtml, /reload_plugin/);

    // 2. Drop-in command plugin handles @bot ping and appears in @bot help
    await sendSim('@bot ping hello');
    await until(() => sim.history.some((m) => (m.text || '').includes('pong-v1:cfg:hello')));

    await sendSim('@bot help');
    await until(() => sim.history.some((m) => (m.text || '').includes('扩展指令') && (m.text || '').includes('`@bot ping`')));

    // 3. Drop-in security redactor plugin redacts custom secret in outbound reply and cleans up on unmount
    assert.ok(listCustomRedactors().includes('emp_int_secret'));
    await sendSim('@bot check leak');
    await until(() => sim.history.some((m) => (m.text || '').includes('[已脱敏:emp_int_secret]')));
    assert.equal(sim.history.some((m) => (m.text || '').includes('EMP_INT_99887766')), false);

    // 4. Drop-in audio hook transcribes uploaded voice attachment
    const upRes = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'self',
        name: 'voice.ogg',
        data: Buffer.from('OggS-mock').toString('base64'),
      }),
    }).then((r) => r.json()) as { ok: boolean; id: string };
    assert.equal(upRes.ok, true);
    await sendSim('@bot 请听语音', upRes.id);
    await until(() => sim.history.some((m) => (m.text || '').includes('转写:voice.ogg')));

    // 5. Phase 4 hot reload: rewrite ping-ext.ts on disk and trigger reload_plugin over HTTP
    fs.writeFileSync(pingFile, `
export const name = 'ping-ext';
export const inject = ['commands'];
export function apply(ctx, opts) {
  const commands = ctx.get('commands');
  commands.register({
    name: 'ping',
    aliases: ['探针'],
    description: '热重载探针v2',
    async handler(cmd) {
      await cmd.reply('pong-v2:' + (opts.suffix || 'base'));
    },
  });
}
`);

    const reloadRes = await fetch(`${baseUrl}/api/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reload_plugin', name: 'ping-ext' }),
    }).then((r) => r.json()) as { ok: boolean; plugin: KernelPluginStatus };
    assert.equal(reloadRes.ok, true);
    assert.equal(reloadRes.plugin.active, true);
    assert.equal(reloadRes.plugin.error, null);

    await sendSim('@bot 探针');
    await until(() => sim.history.some((m) => (m.text || '').includes('pong-v2:cfg')));

    // Verify debug events logged plugin_reloaded
    const evRes = await fetch(`${baseUrl}/api/debug/events?type=plugin_reloaded`).then((r) => r.json()) as {
      events: Array<{ summary: string }>;
    };
    assert.ok(evRes.events.some((e) => e.summary === 'reloaded:ping-ext'));

    // Unmounting redactor-ext removes custom secret rule immediately
    await kernel.unmount('redactor-ext');
    assert.equal(listCustomRedactors().includes('emp_int_secret'), false);
    assert.equal(scanAndRedactOutbound('EMP_INT_99887766').redacted, false);

    // Reloading built-in plugin must fail cleanly without disturbing kernel
    const failBuiltIn = await fetch(`${baseUrl}/api/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reload_plugin', name: 'sim' }),
    });
    assert.equal(failBuiltIn.status, 400);

    const typeAssertions: [CommandRegistryService | null, SecurityExtensionService | null, HooksExtensionService | null] = [null, null, null];
    void typeAssertions;
  } finally {
    await kernel.stop();
    await omb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
