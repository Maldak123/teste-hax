import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.js';
import { createPublisher } from '../src/server/discord.js';
import { requestHandler } from '../src/server/index.js';
import { Bot } from '../src/app/browser.js';
import { RateLimiter } from '../src/domain/chat.js';

const key = 'a'.repeat(40);
const record = id => ({ matchId: id, reason: 'victory', scores: { red: 1, blue: 0, time: 150 }, validForRating: true, statistics: { goals: [{ team: 1 }], players: {}, definitionVersion: 1 }, players: [{ playerId: 'p1', team: 1, activeSeconds: 120 }, { playerId: 'p2', team: 2, activeSeconds: 120 }] });

test('store deduplicates finalization, persists replay and rating across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haxball-'));
  try {
    const store = new Store(dir, key);
    await store.init();
    const alice = await store.identity('auth-a', 'network', 'Alice', 'auth-a');
    assert.equal(alice.role, 'owner');
    assert.equal((await readFile(path.join(dir, 'state.json'), 'utf8')).includes('auth-a'), false);
    const bytes = new Uint8Array(20).fill(3);
    assert.equal((await store.replay('match-1', bytes)).size, 20);
    assert.equal(await store.commitMatch(record('match-1')), true);
    assert.equal(await store.commitMatch(record('match-1')), false);
    store.state.replays['match-1'].retentionAt = new Date(0).toISOString();
    store.state.outbox['match-result:match-1'].status = 'sent';
    await store.prune();
    assert.equal(store.state.matches['match-1'].replay.status, 'expired');
    assert.equal(store.state.ratings.p1.value, 1016);
    assert.equal(store.state.ratings.p1.matches, 1);
    const rejoin = record('match-rejoin');
    rejoin.players.push({ playerId: 'p1', team: 1, activeSeconds: 45 });
    await store.commitMatch(rejoin);
    assert.equal(store.state.ratings.p1.matches, 2);
    await store.startMatch('interrupted', new Date().toISOString());
    const recovered = new Store(dir, key);
    await recovered.init();
    assert.equal(recovered.state.matches['match-1'].replay.status, 'expired');
    assert.equal(recovered.state.ratings.p1.value, 1032);
    assert.equal(recovered.state.interruptedMatches.interrupted.reason, 'process_restart');
    assert.equal(recovered.state.matches.interrupted, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publisher retries 429 and records uncertain network result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haxball-'));
  try {
    const store = new Store(dir, key);
    await store.init();
    await store.commitMatch(record('match-2'));
    let requests = 0;
    const publisher = createPublisher(store, { webhook: 'https://discord.com/api/webhooks/1/test', uploadMaxBytes: 1000 }, async () => {
      requests++;
      if (requests === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.001' } });
      throw new Error('timeout');
    });
    await publisher.tick();
    assert.equal(store.state.outbox['match-result:match-2'].status, 'pending');
    store.state.outbox['match-result:match-2'].nextAt = 0;
    await publisher.tick();
    assert.equal(store.state.outbox['match-result:match-2'].status, 'uncertain');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local HTTP API filters unrelated browser origins and accepts official origin', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haxball-'));
  const store = new Store(dir, key);
  await store.init();
  const handler = requestHandler({ room: { roomName: 'Test' }, ownerAuth: 'owner', adminPassword: 'strong-password-123' }, store);
  const request = async (origin, url = '/config', input) => {
    const headers = {};
    const res = { status: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, writeHead(status) { this.status = status; return this; }, end(data) { this.body = data; return this; } };
    const req = { headers: { origin }, method: input ? 'POST' : 'GET', url, async *[Symbol.asyncIterator]() { if (input) yield Buffer.from(JSON.stringify(input)); } };
    await handler(req, res);
    return { ...res, headers };
  };
  try {
    assert.equal((await request('https://evil.example')).status, 403);
    const response = await request('https://html5.haxball.com');
    assert.equal(response.headers['access-control-allow-origin'], 'https://html5.haxball.com');
    assert.deepEqual(JSON.parse(response.body), { roomName: 'Test' });
    assert.equal(JSON.parse((await request('https://html5.haxball.com', '/health')).body).status, 'ok');
    const identity = await store.identity('verified', null, 'Name', 'owner');
    assert.equal((await request('https://html5.haxball.com', '/admin/login', { loginProof: identity.loginProof, password: 'wrong-password-123' })).status, 401);
    assert.equal((await request('https://html5.haxball.com', '/admin/login', { loginProof: identity.loginProof, password: 'strong-password-123' })).status, 200);
    const guest = await store.identity(null, null, 'Guest', 'owner');
    assert.equal(guest.authenticated, false);
    assert.equal((await request('https://html5.haxball.com', '/admin/login', { loginProof: guest.loginProof, password: 'strong-password-123' })).status, 200);
    assert.equal((await request('https://html5.haxball.com', '/admin/login', { loginProof: `${guest.loginProof}x`, password: 'strong-password-123' })).status, 401);
    assert.equal(store.state.audits.at(-1).event, 'admin_login');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fake Headless room confirms async moves and stops recording once', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/identity') ? { playerId: 'p', role: 'player', connHash: 'h' } : url.endsWith('/ratings') ? {} : { created: true }), { headers: { 'content-type': 'application/json' } });
  let recordingStops = 0;
  let started = 0;
  let unauthorizedStops = 0;
  const players = [{ id: 1, name: 'A', team: 0, auth: 'a', conn: 'x' }, { id: 2, name: 'B', team: 0, auth: 'b', conn: 'y' }];
  const room = {
    getPlayerList: () => players,
    setPlayerTeam(id, team) { queueMicrotask(() => { const player = players.find(p => p.id === id); player.team = team; room.onPlayerTeamChange(player, null); }); },
    startGame() { started++; room.onGameStart(null); },
    startRecording() {},
    stopGame() { unauthorizedStops++; },
    stopRecording() { recordingStops++; return new Uint8Array(20).fill(1); },
    sendAnnouncement() {},
    getScores: () => started ? { red: 1, blue: 0, time: 150 } : null
  };
  try {
    const bot = new Bot(room, { teamSize: 1, minRatingSeconds: 1 });
    players.forEach(p => room.onPlayerJoin(p));
    bot.balance();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(started, 1);
    assert.equal(bot.state, 'PLAYING');
    assert.equal(room.onPlayerChat(players[0], '!end'), false);
    assert.equal(unauthorizedStops, 0);
    room.onGamePause(null);
    assert.equal(bot.state, 'PAUSED');
    room.onGameUnpause(null);
    room.onGameTick();
    assert.equal(bot.state, 'PLAYING');
    room.onGameStop(null);
    room.onTeamVictory(room.getScores());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recordingStops, 1);
    assert.equal(bot.state, 'LOBBY');
    clearTimeout(bot.balanceTimer);
  } finally { globalThis.fetch = oldFetch; }
});

test('automatic start retries when the first Headless start request is ignored', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.endsWith('/identity') ? { playerId: 'p', role: 'player', authenticated: true } : {});
  const players = [{ id: 1, name: 'A', team: 1 }, { id: 2, name: 'B', team: 2 }];
  let requests = 0;
  let started = false;
  const room = {
    getPlayerList: () => players,
    getScores: () => started ? { red: 0, blue: 0, time: 0 } : null,
    startGame() { if (++requests === 2) { started = true; room.onGameStart(null); } },
    startRecording() {}, sendAnnouncement() {}
  };
  try {
    const bot = new Bot(room, { teamSize: 1, minRatingSeconds: 0 });
    players.forEach(player => room.onPlayerJoin(player));
    bot.balance();
    bot.tryStart();
    assert.equal(bot.state, 'PREPARING');
    bot.tryStart();
    assert.equal(requests, 2);
    assert.equal(bot.state, 'PLAYING');
    clearTimeout(bot.balanceTimer);
    clearTimeout(bot.startTimer);
  } finally { globalThis.fetch = oldFetch; }
});

test('one player joins a team and starts a match automatically', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.endsWith('/identity') ? { playerId: 'guest-1', role: 'player', loginProof: 'proof' } : {});
  const player = { id: 1, name: 'Solo', team: 0, auth: null, conn: null };
  let starts = 0;
  const room = {
    getPlayerList: () => [player],
    setPlayerTeam(id, team) { assert.equal(id, 1); queueMicrotask(() => { player.team = team; room.onPlayerTeamChange(player, null); }); },
    startGame() { starts++; room.onGameStart(null); },
    startRecording() {}, sendAnnouncement() {}, getScores: () => starts ? { red: 0, blue: 0, time: 0 } : null
  };
  try {
    const bot = new Bot(room, { teamSize: 4, minRatingSeconds: 120 });
    room.onPlayerJoin(player);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(player.team, 1);
    assert.equal(starts, 1);
    assert.equal(bot.state, 'PLAYING');
    clearTimeout(bot.balanceTimer);
  } finally { globalThis.fetch = oldFetch; }
});

test('one-player match finishes and persists through the real store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haxball-'));
  const store = new Store(dir, key);
  await store.init();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const route = String(url).replace(/^null/, '');
    const input = options.body && !(options.body instanceof Uint8Array) ? JSON.parse(options.body) : null;
    if (route === '/identity') return Response.json(await store.identity(input.auth, input.conn, input.name, 'owner'));
    if (route === '/ratings') return Response.json(store.state.ratings);
    if (route === '/match-start') { await store.startMatch(input.matchId, input.startedAt); return new Response(null, { status: 204 }); }
    if (route === '/match') return Response.json({ created: await store.commitMatch(input) });
    throw new Error(`Unexpected route: ${route}`);
  };
  const player = { id: 1, name: 'Solo', team: 0, auth: null, conn: null };
  let scores = null;
  const room = {
    getPlayerList: () => [player],
    setPlayerTeam(_id, team) { queueMicrotask(() => { player.team = team; room.onPlayerTeamChange(player, null); }); },
    startGame() { scores = { red: 0, blue: 0, time: 0 }; room.onGameStart(null); },
    getScores: () => scores,
    startRecording() {}, stopRecording: () => null, sendAnnouncement() {}
  };
  let bot;
  try {
    bot = new Bot(room, { teamSize: 1, minRatingSeconds: 120 });
    room.onPlayerJoin(player);
    await new Promise(resolve => setTimeout(resolve, 850));
    scores = { red: 0, blue: 0, time: 1 };
    room.onGameTick();
    await bot.finish('stopped', scores);
    assert.equal(Object.keys(store.state.matches).length, 1);
    assert.equal(store.state.matches[Object.keys(store.state.matches)[0]].validForRating, false);
    assert.equal(bot.state, 'LOBBY');
  } finally {
    clearTimeout(bot?.balanceTimer);
    clearTimeout(bot?.retryTimer);
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-match strength swap waits for two reset observations', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Response(JSON.stringify({ playerId: JSON.parse(options.body).auth, role: 'player' }), { headers: { 'content-type': 'application/json' } });
  const players = [
    { id: 1, name: 'A', team: 1, auth: 'a' }, { id: 2, name: 'B', team: 1, auth: 'b' },
    { id: 3, name: 'C', team: 2, auth: 'c' }, { id: 4, name: 'D', team: 2, auth: 'd' }
  ];
  const room = {
    getPlayerList: () => players,
    setPlayerTeam(id, team) { queueMicrotask(() => { const p = players.find(player => player.id === id); p.team = team; room.onPlayerTeamChange(p, null); }); },
    sendAnnouncement() {}, startRecording() {},
    getScores: () => ({ red: 0, blue: 0, time: 0 })
  };
  try {
    const ratings = { a: { value: 1600, matches: 10 }, b: { value: 1400, matches: 10 }, c: { value: 900, matches: 10 }, d: { value: 800, matches: 10 } };
    const bot = new Bot(room, { teamSize: 2, minRatingSeconds: 0 }, ratings);
    players.forEach(player => room.onPlayerJoin(player));
    await Promise.all([...bot.sessions.values()].map(session => session.identityPromise));
    room.onGameStart(null);
    room.onPositionsReset();
    assert.equal(players[0].team, 1);
    room.onPositionsReset();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(players[0].team, 2);
    assert.equal(players[2].team, 1);
    assert.equal(bot.match.balanceMoves, 2);
    clearTimeout(bot.balanceTimer);
    clearTimeout(bot.pendingTimer);
  } finally { globalThis.fetch = oldFetch; }
});

test('failed result save frees lobby, warns admins once, and retries in background', async () => {
  const oldFetch = globalThis.fetch;
  let commits = 0;
  const messages = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/match') && ++commits < 3) throw new Error('offline');
    return new Response(JSON.stringify(url.endsWith('/ratings') ? {} : { created: true }), { headers: { 'content-type': 'application/json' } });
  };
  const player = { id: 3, name: 'Solo', team: 1 };
  let starts = 0;
  const room = {
    sendAnnouncement(...args) { messages.push(args); }, startRecording() {}, stopRecording: () => null,
    getPlayerList: () => [player], getScores: () => null,
    startGame() { starts++; room.onGameStart(null); }
  };
  let bot;
  try {
    bot = new Bot(room, { teamSize: 1, minRatingSeconds: 120 });
    room.onGameStart(null);
    bot.sessions.set(1, { role: 'owner', roomPlayerId: 1 });
    bot.sessions.set(2, { role: 'player', roomPlayerId: 2 });
    await bot.finish('stopped', { red: 0, blue: 0, time: 1 });
    assert.equal(bot.state, 'LOBBY');
    assert.ok(bot.retryTimer);
    assert.equal(bot.pendingResults.size, 1);
    assert.equal(messages.filter(message => message[0].includes('Falha ao salvar')).length, 1);
    assert.equal(messages.find(message => message[0].includes('Falha ao salvar'))[1], 1);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(starts, 1);
    assert.equal(bot.state, 'PLAYING');
    await bot.retryPendingResults();
    assert.equal(bot.pendingResults.size, 1);
    assert.equal(messages.filter(message => message[0].includes('Falha ao salvar')).length, 1);
    await bot.retryPendingResults();
    assert.equal(bot.state, 'PLAYING');
    assert.equal(commits, 3);
    assert.equal(bot.pendingResults.size, 0);
    assert.equal(messages.filter(message => message[0].includes('Falha ao salvar')).length, 1);
  } finally { clearTimeout(bot?.balanceTimer); clearTimeout(bot?.startTimer); clearTimeout(bot?.retryTimer); globalThis.fetch = oldFetch; }
});

test('admin login is private, temporary, and absent from public help', async () => {
  const oldFetch = globalThis.fetch;
  const messages = [];
  let stops = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/identity')) return Response.json({ playerId: 'p1', role: 'player', authenticated: false, loginProof: 'proof' });
    if (url.endsWith('/admin/login')) return new Response(JSON.stringify({ ok: true }), { status: JSON.parse(options.body).password === 'correct-password-123' ? 200 : 401 });
    return Response.json({});
  };
  const player = { id: 1, name: 'Player', team: 0, auth: 'valid' };
  const room = { sendAnnouncement(...args) { messages.push(args); }, getPlayerList: () => [player], stopGame() { stops++; } };
  try {
    const bot = new Bot(room, { teamSize: 1 });
    room.onPlayerJoin(player);
    await bot.session(player).identityPromise;
    bot.chatLimit = new RateLimiter({ capacity: 20 });
    bot.globalChatLimit = new RateLimiter({ capacity: 20 });
    assert.equal(room.onPlayerChat(player, '!help'), false);
    assert.equal(messages.at(-1)[0].includes('!balance'), false);
    assert.equal(messages.at(-1)[3], 'small-bold');
    assert.equal(room.onPlayerChat(player, '!login wrong-password-123'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bot.session(player).role, 'player');
    assert.equal(messages.at(-1)[1], player.id);
    assert.equal(messages.at(-1)[3], 'small-bold');
    room.onPlayerChat(player, '!login correct-password-123');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bot.session(player).role, 'admin');
    assert.equal(messages.at(-1)[1], player.id);
    assert.equal(messages.at(-1)[3], 'small-bold');
    room.onPlayerChat(player, '!adminhelp');
    assert.equal(messages.at(-1)[0].includes('!balance'), true);
    bot.state = 'PLAYING';
    room.onPlayerChat(player, '!end');
    assert.equal(stops, 1);
    room.onPlayerChat(player, '!logout');
    room.onPlayerChat(player, '!end');
    assert.equal(stops, 1);
    clearTimeout(bot.balanceTimer);
  } finally { globalThis.fetch = oldFetch; }
});
