import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { CdpPage, chromeArgs, injection, launchWindowsChrome } from '../src/launcher/chrome.js';

test('Chrome args enable VPS WebRTC connectivity only when configured', () => {
  const base = chromeArgs({ port: 9222, profile: '/tmp/profile', headless: true, disableWebRtcLocalIpAnonymization: false });
  assert.deepEqual(base, [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=/tmp/profile', '--no-first-run', '--headless=new', 'about:blank'
  ]);
  assert.ok(chromeArgs({ port: 9222, profile: '/tmp/profile', headless: false, disableWebRtcLocalIpAnonymization: true }).includes('--disable-features=WebRtcHideLocalIpsWithMdns'));
  assert.ok(chromeArgs({ port: 9222, profile: '/tmp/profile', headless: false, disableWebRtcLocalIpAnonymization: true, allowPrivateNetworkAccess: true }).includes('--disable-features=WebRtcHideLocalIpsWithMdns,BlockInsecurePrivateNetworkRequests'));
});

test('Chrome injection waits for HBInit and starts the bot only once', async () => {
  const intervals = new Set();
  const window = { readyCalls: 0, __haxballBotReady() { this.readyCalls++; } };
  const context = {
    window,
    setInterval(callback) { intervals.add(callback); return callback; },
    clearInterval(callback) { intervals.delete(callback); }
  };
  vm.runInNewContext(injection('window.haxballBot = { started: (window.haxballBot?.started ?? 0) + 1 };'), context);
  assert.equal(window.haxballBot, undefined);
  window.HBInit = () => {};
  for (const tick of [...intervals]) tick();
  for (const tick of [...intervals]) tick();
  assert.equal(window.haxballBot.started, 1);
  assert.equal(window.readyCalls, 0);
  window.__haxballBotRoomReady = true;
  for (const tick of [...intervals]) tick();
  assert.equal(window.readyCalls, 1);
});

test('DevTools command resolves responses and forwards events', async () => {
  const handlers = new Map();
  const sent = [];
  const socket = {
    addEventListener(event, fn) { handlers.set(event, fn); },
    send(value) { sent.push(JSON.parse(value)); },
    close() {}
  };
  const page = new CdpPage(socket);
  let payload;
  page.on('Runtime.bindingCalled', value => { payload = value.payload; });
  const response = page.send('Page.enable');
  assert.equal(sent[0].method, 'Page.enable');
  handlers.get('message')({ data: JSON.stringify({ id: sent[0].id, result: { ok: true } }) });
  assert.deepEqual(await response, { ok: true });
  handlers.get('message')({ data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { payload: 'ready' } }) });
  assert.equal(payload, 'ready');
});

test('WSL passes bootstrap to Windows PowerShell and waits for room readiness', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  let input;
  let closedWith;
  child.stdin.write = value => { input = value; };
  child.stdin.end = value => { closedWith = value; };
  child.kill = () => {};
  const spawnProcess = (file, args, options) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(args[2], '-EncodedCommand');
    assert.ok(Buffer.from(args[3], 'base64').toString('utf16le').includes('[ScriptBlock]::Create'));
    assert.equal(options.cwd, '/mnt/c/Windows');
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('BOT_PAGE\nBOT_READY\n')));
    return child;
  };
  const browser = await launchWindowsChrome('window.haxballBot = {};', { chrome: 'C:\\Chrome.exe', port: 0, spawnProcess });
  const [script, bootstrap] = input.trim().split('\n').map(line => Buffer.from(line, 'base64').toString());
  assert.ok(script.includes('$BotPort = 0'));
  assert.ok(script.includes('BOT_STAGE:script carregado'));
  assert.ok(bootstrap.includes('window.haxballBot = {};'));
  browser.close();
  assert.equal(closedWith, 'stop\n');
});

test('WSL reports the failing PowerShell stage without CLIXML progress', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {};
  child.kill = () => {};
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('BOT_STAGE:Chrome iniciado\nBOT_ERROR_B64:'));
      child.stdout.emit('data', Buffer.from(`${Buffer.from('Chrome did not open its DevTools port').toString('base64')}\n`));
      child.stderr.emit('data', Buffer.from('#< CLIXML<Objs><Obj S="progress" /></Objs>'));
      child.emit('exit', 1);
    });
    return child;
  };
  await assert.rejects(
    launchWindowsChrome('', { chrome: 'C:\\Chrome.exe', port: 0, spawnProcess }),
    /Etapa Chrome iniciado: Chrome did not open its DevTools port/
  );
});
