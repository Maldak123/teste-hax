import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createPublisher } from './discord.js';
import { AdminAuthenticator } from './admin-auth.js';

const origins = new Set(['https://html5.haxball.com', 'https://www.haxball.com']);

async function body(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Corpo muito grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function requestHandler(config, store) {
  const adminAuth = new AdminAuthenticator(config.adminPassword);
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) { res.writeHead(403).end(); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/config') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(config.room));
      } else if (req.method === 'GET' && url.pathname === '/ratings') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(store.state.ratings));
      } else if (req.method === 'GET' && url.pathname === '/health') {
        const counts = {};
        for (const item of Object.values(store.state.outbox)) counts[item.status] = (counts[item.status] ?? 0) + 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', matches: Object.keys(store.state.matches).length, interruptedMatches: Object.keys(store.state.interruptedMatches).length, activeMatches: Object.keys(store.state.activeMatches).length, outbox: counts }));
      } else if (req.method === 'POST' && url.pathname === '/identity') {
        const input = JSON.parse((await body(req, 2048)).toString());
        const result = await store.identity(input.auth, input.conn, input.name, config.ownerAuth);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } else if (req.method === 'POST' && url.pathname === '/admin/login') {
        const input = JSON.parse((await body(req, 1024)).toString());
        const playerId = store.verifyLoginProof(input.loginProof);
        const identity = playerId ? store.state.identities[playerId] : null;
        const result = adminAuth.verify(playerId, input.password, Boolean(identity));
        await store.audit({ event: 'admin_login', actor: identity?.playerId ?? 'unknown', result: result.reason });
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(result.ok ? 200 : result.reason === 'locked' ? 429 : 401).end(JSON.stringify({ ok: result.ok }));
      } else if (req.method === 'POST' && url.pathname === '/match-start') {
        const input = JSON.parse((await body(req, 2048)).toString());
        await store.startMatch(input.matchId, input.startedAt);
        res.writeHead(204).end();
      } else if (req.method === 'POST' && /^\/replay\/[\w-]{1,80}$/.test(url.pathname)) {
        const result = await store.replay(url.pathname.slice(8), await body(req, 25_000_001));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ checksum: result.checksum, size: result.size, status: result.status }));
      } else if (req.method === 'POST' && url.pathname === '/match') {
        const match = JSON.parse((await body(req, 100_000)).toString());
        const created = await store.commitMatch(match);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ created }));
      } else if (req.method === 'POST' && url.pathname === '/audit') {
        const input = JSON.parse((await body(req, 2048)).toString());
        await store.audit({ event: String(input.event ?? '').slice(0, 60), actor: String(input.actor ?? '').slice(0, 80), result: String(input.result ?? '').slice(0, 60) });
        res.writeHead(204).end();
      } else { res.writeHead(404).end(); }
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, error: error.message }));
      const invalid = error instanceof SyntaxError || ['Corpo muito grande', 'Partida inválida', 'Placar inválido', 'Participação inválida', 'Evento de gol inválido'].includes(error.message);
      const status = error.message === 'Corpo muito grande' ? 413 : invalid ? 422 : 500;
      res.writeHead(status).end('Request failed');
    }
  };
}

export function createServer(config, store) { return http.createServer(requestHandler(config, store)); }

export async function startService(config) {
  const store = new Store(config.dataDir, config.hmacKey, config.room.minRatingSeconds, config.replayRetentionDays);
  await store.init();
  const publisher = createPublisher(store, config);
  const server = createServer(config, store);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  console.log(`Bot service listening on http://127.0.0.1:${config.port}`);
  const interval = setInterval(() => publisher.tick().catch(error => console.error(JSON.stringify({ event: 'publisher_error', error: error.message }))), 3000);
  const pruneInterval = setInterval(() => store.prune().catch(error => console.error(JSON.stringify({ event: 'prune_error', error: error.message }))), 3_600_000);
  return { server, store, close: () => { clearInterval(interval); clearInterval(pruneInterval); return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await startService(loadConfig());
  process.on('SIGINT', () => { void service.close(); });
  process.on('SIGTERM', () => { void service.close(); });
}
