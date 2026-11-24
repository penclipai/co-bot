import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT } from '../src/config.js';
import { OpenMausBotClient } from '../src/openmausbot/client.js';
import { isLoopbackUrl, findOpenMausBotServer, ensureOpenMausBot } from '../scripts/omb.js';
import { getFreePort, startMockOmb } from './helpers/mock-omb.js';

const execFileAsync = promisify(execFile);

test('cross-platform: patchBot, downloadMessageFile path basename on Windows/POSIX, check --fix-cli', async () => {
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true, computer: 'local' }],
    { desktopManaged: false },
  );
  const csv = Buffer.from('a,b\n1,2\n', 'utf8');
  omb.setMedia('m1', 'C:\\out\\report.csv', { buf: csv, mime: 'text/csv' });
  omb.setMedia('m1', '/tmp/out/report.csv', { buf: csv, mime: 'text/csv' });

  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-check-cli-'));
  const tmpCfg = path.join(tmpDir, 'config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify({ channel: { use: 'sim' }, openmausbot: { url: omb.baseUrl }, dataDir: path.join(tmpDir, 'data') }));

  try {
    const winRes = await client.downloadMessageFile('t1', 'm1', 'C:\\out\\report.csv');
    const posixRes = await client.downloadMessageFile('t1', 'm1', '/tmp/out/report.csv');
    assert.equal(winRes.name, 'report.csv');
    assert.equal(posixRes.name, 'report.csv');

    const p1 = await client.patchBot('b1', { computer: 'off' });
    assert.equal(p1.bot.computer, 'off');
    await client.patchBot('b1', { computer: 'local' });

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(APP_ROOT, 'scripts', 'check.js'), '--fix-cli', '--omb', omb.baseUrl, '--config', tmpCfg],
      { cwd: os.tmpdir() },
    );
    assert.match(stdout, /CLI 模式/);
    assert.match(stdout, /computer 设为 off/);

    const after = await client.listBots();
    assert.equal(after.bots[0].computer, 'off');
  } finally {
    await omb.close();
  }
});

test('scripts/daemon.js: cross-platform start, status, and stop lifecycle', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-daemon-'));
  const tmpCfg = path.join(tmpDir, 'config.json');
  const dataDir = path.join(tmpDir, 'data');
  fs.writeFileSync(tmpCfg, JSON.stringify({
    openmausbot: { url: omb.baseUrl },
    channel: { use: 'sim' },
    web: { host: '127.0.0.1', port },
    dataDir,
  }));

  const daemonScript = path.join(APP_ROOT, 'scripts', 'daemon.js');
  try {
    const startRes = await execFileAsync(process.execPath, [daemonScript, 'start', '--config', tmpCfg], { cwd: os.tmpdir() });
    assert.match(startRes.stdout, /已启动/);

    const h = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    assert.equal(h.ok, true);

    const statusRes = await execFileAsync(process.execPath, [daemonScript, 'status', '--config', tmpCfg], { cwd: os.tmpdir() });
    assert.match(statusRes.stdout, /运行中/);
  } finally {
    await execFileAsync(process.execPath, [daemonScript, 'stop', '--config', tmpCfg], { cwd: os.tmpdir() }).catch(() => {});
    assert.equal(fs.existsSync(path.join(dataDir, 'cobot.pid')), false);
    await omb.close();
  }
});

test('scripts/omb.js: isLoopbackUrl, global CLI discovery, and ensureOpenMausBot CLI computer=off alignment', async () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8799'), true);
  assert.equal(isLoopbackUrl('http://localhost:8799'), true);
  assert.equal(isLoopbackUrl('http://10.0.0.5:8799'), false);

  assert.equal(findOpenMausBotServer({ run: () => ({ status: 1, stdout: '' }), platform: 'linux' }), null);
  assert.deepEqual(
    findOpenMausBotServer({
      run: (cmd) => (cmd === 'openmausbot' ? { status: 0, stdout: '0.1.177\n' } : { status: 1, stdout: '' }),
      platform: 'linux',
    }),
    { kind: 'cli', command: 'openmausbot', version: '0.1.177' },
  );

  const posixPkg = path.join('/usr/local/lib/node_modules/openmausbot');
  const posixBin = '/usr/local/bin/openmausbot';
  const posixCli = path.join(posixPkg, 'cli.js');
  const posixEntry = path.join(posixPkg, 'dist-server', 'index.js');
  const posixStatic = path.join(posixPkg, 'dist');
  const posixSkills = path.join(posixPkg, 'skills');
  assert.deepEqual(
    findOpenMausBotServer({
      platform: 'linux',
      run: (cmd) => (cmd === 'openmausbot'
        ? { status: 0, stdout: '0.1.177\n' }
        : { status: 0, stdout: `${posixBin}\n` }),
      exists: (p) => new Set([posixBin, posixEntry, path.join(posixStatic, 'index.html'), posixSkills]).has(p),
      realpath: () => posixCli,
    }),
    { kind: 'node', entry: posixEntry, version: '0.1.177', staticDir: posixStatic, skillsDir: posixSkills },
  );

  const fakeNpmDir = path.join(os.tmpdir(), 'fake-npm-global');
  const winPkg = path.join(fakeNpmDir, 'node_modules', 'openmausbot');
  const winEntry = path.join(winPkg, 'dist-server', 'index.js');
  const winStatic = path.join(winPkg, 'dist');
  const winSkills = path.join(winPkg, 'skills');
  assert.deepEqual(
    findOpenMausBotServer({
      platform: 'win32',
      run: (cmd) => (cmd === 'cmd.exe'
        ? { status: 0, stdout: '0.1.177\r\n' }
        : { status: 0, stdout: `${path.join(fakeNpmDir, 'openmausbot.cmd')}\r\n` }),
      exists: (p) => new Set([winEntry, path.join(winStatic, 'index.html'), winSkills]).has(p),
    }),
    { kind: 'node', entry: winEntry, version: '0.1.177', staticDir: winStatic, skillsDir: winSkills },
  );

  const realFound = findOpenMausBotServer();
  assert.ok(realFound === null || realFound.kind === 'cli' || realFound.kind === 'node');

  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true, computer: 'local' }],
    { desktopManaged: false },
  );
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const logs = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ensure-'));

  try {
    // 1. cliComputerOff: false 时不修改 computer
    const res1 = await ensureOpenMausBot(
      { openmausbot: { url: omb.baseUrl, autoStart: true, cliComputerOff: false }, dataDir },
      { log: (s) => logs.push(s) },
    );
    assert.deepEqual(res1, { running: true, started: false });
    assert.equal((await client.listBots()).bots[0].computer, 'local');

    // 2. 默认 cliComputerOff: true 自动将 CLI 模式主 Bot 设为 off
    const res2 = await ensureOpenMausBot(
      { openmausbot: { url: omb.baseUrl, autoStart: true, cliComputerOff: true }, dataDir },
      { log: (s) => logs.push(s) },
    );
    assert.deepEqual(res2, { running: true, started: false });
    assert.equal((await client.listBots()).bots[0].computer, 'off');
    assert.ok(logs.some((l) => l.includes('computer 设为 off')));
  } finally {
    await omb.close();
  }
});
