import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const pageUrl = 'https://html5.haxball.com/headless';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function findChrome(override = process.env.CHROME_PATH) {
  if (override) return override;
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Chromium não encontrado. Defina CHROME_PATH.');
}

function profileFor(chrome) {
  if (process.env.CHROME_PROFILE_DIR) return process.env.CHROME_PROFILE_DIR;
  return path.join(os.tmpdir(), 'bot-haxball-chrome');
}

export function chromeArgs({ port, profile, headless = process.env.CHROME_HEADLESS === 'true', disableWebRtcLocalIpAnonymization = process.env.CHROME_DISABLE_WEBRTC_LOCAL_IP_ANONYMIZATION === 'true', allowPrivateNetworkAccess = process.env.CHROME_ALLOW_PRIVATE_NETWORK_ACCESS === 'true' }) {
  const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run'];
  if (headless) args.push('--headless=new');
  const disabledFeatures = [];
  // Required by the official Headless Host documentation when the host runs on a VPS.
  if (disableWebRtcLocalIpAnonymization) disabledFeatures.push('WebRtcHideLocalIpsWithMdns');
  // Lets the official HaxBall page reach this bot's loopback-only local API.
  if (allowPrivateNetworkAccess) disabledFeatures.push('BlockInsecurePrivateNetworkRequests');
  if (disabledFeatures.length) args.push(`--disable-features=${disabledFeatures.join(',')}`);
  args.push('about:blank');
  return args;
}

const powershellString = value => Buffer.from(value, 'utf8').toString('base64');

export async function launchWindowsChrome(bundle, { chrome, port, roomReadyTimeoutMs = 300_000, spawnProcess = spawn } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CHROME_DEBUG_PORT inválida');
  const chromePath = /^[A-Za-z]:\\/.test(chrome) ? chrome : execFileSync('wslpath', ['-w', chrome], { encoding: 'utf8' }).trim();
  if (process.env.CHROME_PROFILE_DIR && !/^[A-Za-z]:\\/.test(process.env.CHROME_PROFILE_DIR)) throw new Error('No WSL, CHROME_PROFILE_DIR deve ser um caminho Windows (C:\\...).');
  const script = await readFile(new URL('../../scripts/windows-launch.ps1', import.meta.url), 'utf8');
  const config = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$BotChromePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${powershellString(chromePath)}'))`,
    `$BotProfileDir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${powershellString(process.env.CHROME_PROFILE_DIR ?? '')}'))`,
    `$BotPort = ${port}`,
    `$BotHeadless = ${process.env.CHROME_HEADLESS === 'true' ? '$true' : '$false'}`
  ].join('\n');
  // Keep the Windows command line short and report PowerShell parse errors plainly.
  const runner = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $scriptLine = [Console]::In.ReadLine()
  if (-not $scriptLine) { throw 'Windows launcher script was not provided' }
  $scriptText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($scriptLine))
  & ([ScriptBlock]::Create($scriptText))
} catch {
  $detail = [Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message)
  [Console]::Out.WriteLine('BOT_ERROR_B64:' + [Convert]::ToBase64String($detail))
  [Console]::Out.Flush()
  exit 1
}`;
  const encoded = Buffer.from(runner, 'utf16le').toString('base64');
  const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: '/mnt/c/Windows', stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  let errors = '';
  let pageReported = false;
  let stage = 'PowerShell iniciado';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`A sala não ficou pronta no Chrome do Windows no prazo. Última etapa: ${stage}.`)), roomReadyTimeoutMs);
    const fail = message => { clearTimeout(timeout); reject(new Error(message)); };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/).slice(0, -1)) {
        if (line.startsWith('BOT_STAGE:')) stage = line.slice('BOT_STAGE:'.length).trim();
        if (line.startsWith('BOT_ERROR_B64:')) {
          const detail = Buffer.from(line.slice('BOT_ERROR_B64:'.length), 'base64').toString('utf8');
          fail(`Etapa ${stage}: ${detail.slice(0, 500)}`);
        }
      }
      if (!pageReported && output.includes('BOT_PAGE')) { pageReported = true; console.log('Página Headless aberta no Chrome; aguardando a sala ficar pronta.'); }
      if (output.includes('BOT_READY')) { clearTimeout(timeout); resolve(); }
      output = output.slice(output.lastIndexOf('\n') + 1);
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-16_384); });
    child.once('error', error => fail(`PowerShell não iniciou: ${error.message}`));
    child.once('exit', code => {
      const detail = errors.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/^#< CLIXML\s*/i, '').trim();
      fail(`Chrome do Windows terminou (${code}) na etapa ${stage}: ${detail ? detail.slice(-500) : 'erro detalhado indisponível'}`);
    });
  });
  const stopOnSignal = () => child.kill();
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  child.stdin.on('error', () => {});
  child.stdin.write(`${powershellString(`${config}\n${script}`)}\n${powershellString(injection(bundle))}\n`);
  try {
    await ready;
    process.removeListener('SIGINT', stopOnSignal);
    process.removeListener('SIGTERM', stopOnSignal);
    return { child, close: () => { child.stdin.end('stop\n'); } };
  } catch (error) {
    process.removeListener('SIGINT', stopOnSignal);
    process.removeListener('SIGTERM', stopOnSignal);
    child.kill();
    throw error;
  }
}

async function getJson(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000), ...options });
  if (!response.ok) throw new Error(`Chrome DevTools HTTP ${response.status}`);
  return response.json();
}

export class CdpPage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) this.listeners.get(message.method)?.(message.params);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Conexão DevTools encerrada'));
      this.pending.clear();
    });
  }

  on(method, listener) { this.listeners.set(method, listener); }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(new CdpPage(socket)), { once: true });
    socket.addEventListener('error', () => reject(new Error('Não foi possível conectar ao Chrome DevTools')), { once: true });
  });
}

export function injection(bundle) {
  // Page.addScriptToEvaluateOnNewDocument runs in the official page and its same-target frames.
  // See https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument
  return `(() => {
    if (window.__haxballBotLoader) return;
    window.__haxballBotLoader = true;
    const start = () => {
      if (window.__haxballBotStarted || typeof window.HBInit !== 'function') return;
      window.__haxballBotStarted = true;
      ${bundle}
      const ready = setInterval(() => {
        if (window.__haxballBotRoomReady) {
          clearInterval(ready);
          window.__haxballBotReady?.('ready');
        }
      }, 250);
    };
    start();
    const poll = setInterval(() => {
      start();
      if (window.__haxballBotStarted) clearInterval(poll);
    }, 250);
  })();`;
}

export async function launchChrome(bundle, { chrome = findChrome(), port = Number(process.env.CHROME_DEBUG_PORT || (chrome.toLowerCase().endsWith('.exe') ? 0 : 9222)), timeoutMs = 45_000, roomReadyTimeoutMs = 300_000 } = {}) {
  if (chrome.toLowerCase().endsWith('.exe') && process.platform !== 'win32') return launchWindowsChrome(bundle, { chrome, port, roomReadyTimeoutMs });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHROME_DEBUG_PORT inválida');
  const endpoint = `http://127.0.0.1:${port}`;
  try { await getJson(`${endpoint}/json/version`); throw new Error(`Porta ${port} já usada por outro Chrome. Escolha CHROME_DEBUG_PORT.`); }
  catch (error) { if (error.message.includes('já usada')) throw error; }
  const profile = profileFor(chrome);
  const args = chromeArgs({ port, profile });
  const child = spawn(chrome, args, { stdio: 'ignore' });
  const stopOnSignal = () => child.kill();
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  let page;
  let readyTimer;
  let exitError = null;
  child.once('error', error => { exitError = error; });
  child.once('exit', (code, signal) => { exitError = new Error(`Chrome terminou (${code ?? signal})`); });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (exitError) throw exitError;
      try { await getJson(`${endpoint}/json/version`); break; }
      catch { await pause(250); }
    }
    if (Date.now() >= deadline) throw new Error('Chrome não abriu a porta DevTools no prazo.');
    const targets = await getJson(`${endpoint}/json/list`);
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
      ?? await getJson(`${endpoint}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    if (!target.webSocketDebuggerUrl) throw new Error('Chrome não criou a aba Headless.');
    page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Runtime.addBinding', { name: '__haxballBotReady' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: injection(bundle) });
    const ready = new Promise((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('A sala não ficou pronta no prazo. Confira a página e a recaptcha.')), roomReadyTimeoutMs);
      child.once('exit', (code, signal) => reject(new Error(`Chrome terminou antes da sala ficar pronta (${code ?? signal})`)));
      page.on('Runtime.bindingCalled', params => {
        if (params.name === '__haxballBotReady' && params.payload === 'ready') { clearTimeout(readyTimer); resolve(); }
      });
    });
    await Promise.all([
      (async () => {
        const navigation = await page.send('Page.navigate', { url: pageUrl });
        if (navigation.errorText) throw new Error(`Navegação Headless falhou: ${navigation.errorText}`);
        await page.send('Page.bringToFront');
        console.log('Página Headless aberta no Chrome; aguardando a sala ficar pronta.');
      })(),
      ready
    ]);
    process.removeListener('SIGINT', stopOnSignal);
    process.removeListener('SIGTERM', stopOnSignal);
    return { child, page, close: () => { page.close(); child.kill(); } };
  } catch (error) {
    process.removeListener('SIGINT', stopOnSignal);
    process.removeListener('SIGTERM', stopOnSignal);
    clearTimeout(readyTimer);
    page?.close();
    child.kill();
    throw error;
  }
}
