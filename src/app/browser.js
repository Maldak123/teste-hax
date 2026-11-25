import { planTeams } from '../domain/balance.js';
import { Statistics } from '../domain/statistics.js';
import { RateLimiter, parseCommand, cleanText } from '../domain/chat.js';

// RoomObject methods and callbacks below follow the official Headless API:
// https://github.com/haxball/haxball-issues/wiki/Headless-Host
const base = new URL(import.meta.url).origin;
const api = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000), ...options });
  if (!response.ok) {
    const error = new Error(`Local service HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
};
const json = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export class Bot {
  constructor(room, config, ratings = {}) {
    this.room = room;
    this.config = config;
    this.ratings = ratings;
    this.state = 'LOBBY';
    this.sessions = new Map();
    this.pending = new Map();
    this.lastPlayerMoveMs = new Map();
    this.balanceFailures = 0;
    this.pendingTimer = null;
    this.startTimer = null;
    this.startAttempts = 0;
    this.match = null;
    this.retryTimer = null;
    this.pendingResults = new Map();
    this.persistOutageNotified = false;
    this.sequence = 0;
    this.chatLimit = new RateLimiter();
    this.globalChatLimit = new RateLimiter({ capacity: 12, refillMs: 500 });
    this.memeLimit = new RateLimiter({ capacity: 1, refillMs: 30_000 });
    this.globalMemeLimit = new RateLimiter({ capacity: 2, refillMs: 15_000 });
    this.memes = ['Bola no pé, cabeça no jogo!', 'O VAR pediu replay.', 'Fair play vale mais que golaço.'];
    this.memeIndex = 0;
    this.rebalanceAtReset = false;
    this.lastInMatchBalanceMs = -Infinity;
    this.install();
  }

  safe(event, fn, fallback) {
    return (...args) => {
      try { return fn(...args); }
      catch (error) { console.error(JSON.stringify({ event: 'callback_error', callback: event, matchId: this.match?.matchId, error: String(error?.message ?? error).slice(0, 120) })); return fallback; }
    };
  }

  announce(text, targetId, tone = 'info') {
    const themes = {
      info: [0x33D6FF, 'bold', 1],
      private: [0xB8E9FF, 'small-bold', 0],
      success: [0x72E394, 'bold', 2],
      warning: [0xFFBC59, 'bold', 2],
      goal: [0xFFD166, 'bold', 2]
    };
    const [color, style, sound] = themes[tone] ?? themes.info;
    this.room.sendAnnouncement(`✦ BOT | ${cleanText(text, 225)}`, targetId, color, style, sound);
  }
  audit(event, actor, result) { api('/audit', json({ event, actor: actor?.sessionId ?? 'host', result })).catch(() => {}); }
  session(player) { return player ? this.sessions.get(player.id) : null; }

  install() {
    const room = this.room;
    room.onPlayerJoin = this.safe('onPlayerJoin', p => this.join(p));
    room.onPlayerLeave = this.safe('onPlayerLeave', p => this.leave(p));
    room.onPlayerTeamChange = this.safe('onPlayerTeamChange', (p, by) => this.teamChange(p, by));
    room.onPlayerAdminChange = this.safe('onPlayerAdminChange', (p, by) => this.audit('admin_change', this.session(by), `target:${this.session(p)?.sessionId ?? 'unknown'}`));
    room.onPlayerKicked = this.safe('onPlayerKicked', (p, _reason, ban, by) => this.audit('kick', this.session(by), `${ban ? 'ban' : 'kick'}:${this.session(p)?.sessionId ?? 'unknown'}`));
    room.onPlayerChat = this.safe('onPlayerChat', (p, msg) => this.chat(p, msg), false);
    room.onGameStart = this.safe('onGameStart', by => this.gameStart(by));
    room.onGamePause = this.safe('onGamePause', by => { if (this.state === 'PLAYING') { this.state = 'PAUSED'; this.audit('pause', this.session(by), 'ok'); } });
    room.onGameUnpause = this.safe('onGameUnpause', by => { if (this.state === 'PAUSED') { this.match.awaitFirstTick = true; this.audit('unpause', this.session(by), 'ok'); } });
    room.onGameTick = this.safe('onGameTick', () => this.tick());
    room.onPlayerBallKick = this.safe('onPlayerBallKick', p => this.kick(p));
    room.onTeamGoal = this.safe('onTeamGoal', team => this.goal(team));
    room.onPositionsReset = this.safe('onPositionsReset', () => { this.match?.stats.reset(); this.balanceDuringMatch(); });
    room.onPlayerActivity = this.safe('onPlayerActivity', p => { const session = this.session(p); if (session) session.lastActivity = performance.now(); });
    room.onTeamVictory = this.safe('onTeamVictory', scores => { if (this.match?.stopTimer) clearTimeout(this.match.stopTimer); void this.finish('victory', scores); });
    room.onGameStop = this.safe('onGameStop', () => {
      if (this.match && !this.match.finished && !this.match.stopTimer) this.match.stopTimer = setTimeout(() => { void this.finish('stopped', room.getScores()); }, 250);
    });
    room.onStadiumChange = this.safe('onStadiumChange', (_name, by) => this.audit('stadium_change', this.session(by), 'ok'));
    room.onTeamsLockChange = this.safe('onTeamsLockChange', (_locked, by) => this.audit('teams_lock', this.session(by), 'ok'));
    room.onKickRateLimitSet = this.safe('onKickRateLimitSet', (_min, _rate, _burst, by) => this.audit('kick_rate', this.session(by), 'ok'));
    room.onRoomLink = this.safe('onRoomLink', () => { if (typeof window !== 'undefined') window.__haxballBotRoomReady = true; console.info('Room ready; link available in the official Headless page.'); });
  }

  join(player) {
    const session = {
      sessionId: crypto.randomUUID(), roomPlayerId: player.id, name: cleanText(player.name, 40),
      playerId: null, role: 'player', team: player.team, joinedAt: new Date().toISOString(),
      waitingSince: performance.now(), lastActivity: performance.now(),
      teamTimeline: [{ team: player.team, at: new Date().toISOString() }]
    };
    this.sessions.set(player.id, session);
    session.identityPromise = api('/identity', json({ auth: player.auth ?? null, conn: player.conn ?? null, name: session.name }))
      .then(identity => { session.playerId = identity.playerId; session.role = identity.role; session.authenticated = identity.authenticated; session.connHash = identity.connHash; session.loginProof = identity.loginProof; })
      .catch(() => this.announce('Identidade indisponível; comandos administrativos bloqueados.', player.id));
    this.announce('Sala com gravação de replay e estatísticas. Use !help para comandos.', player.id);
    if (this.state === 'LOBBY') this.scheduleBalance();
  }

  leave(player) {
    const session = this.session(player);
    if (!session) return;
    session.leftAt = new Date().toISOString();
    this.sessions.delete(player.id);
    this.pending.delete(player.id);
    this.chatLimit.delete(session.sessionId);
    this.memeLimit.delete(session.sessionId);
    this.lastPlayerMoveMs.delete(session.sessionId);
    this.match?.stats.reset();
    if (this.state === 'PLAYING' && player.team !== 0) this.rebalanceAtReset = true;
    if (this.state === 'LOBBY' || this.state === 'PREPARING') this.scheduleBalance();
  }

  teamChange(player, by) {
    const session = this.session(player);
    if (!session) return;
    const was = session.team;
    session.team = player.team;
    session.teamTimeline.push({ team: player.team, at: new Date().toISOString() });
    if (was !== player.team) this.match?.stats.reset();
    if (this.pending.get(player.id) === player.team) {
      this.pending.delete(player.id);
      if (this.state === 'PLAYING' || this.state === 'PAUSED') this.lastPlayerMoveMs.set(session.sessionId, performance.now());
      if (this.pending.size === 0) this.movementComplete();
    } else if (by) this.audit('manual_team_change', this.session(by), `target:${session.sessionId}`);
  }

  scheduleBalance() {
    if (this.balanceTimer) clearTimeout(this.balanceTimer);
    const delay = this.balanceFailures >= 3 ? 30_000 : 500;
    this.balanceTimer = setTimeout(() => {
      if (this.balanceFailures >= 3) this.balanceFailures = 0;
      this.balance();
    }, delay);
  }

  balance() {
    if (this.state !== 'LOBBY' && this.state !== 'PREPARING') return;
    if (this.pendingResults.size >= 50) return;
    if (this.balanceFailures >= 3) return;
    if (this.pending.size) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startAttempts = 0;
    const players = this.room.getPlayerList().map(p => ({ id: p.id, identityId: this.session(p)?.playerId, waitingSince: this.session(p)?.waitingSince ?? 0 }));
    const ratings = Object.fromEntries(Object.entries(this.ratings).map(([id, rating]) => [id, rating.matches >= 5 ? rating.value : 1000]));
    const plan = planTeams(players, this.config.teamSize, ratings);
    const desired = new Map([...plan.red.map(p => [p.id, 1]), ...plan.blue.map(p => [p.id, 2]), ...plan.queue.map(p => [p.id, 0])]);
    this.state = 'PREPARING';
    for (const player of this.room.getPlayerList()) {
      const team = desired.get(player.id) ?? 0;
      if (player.team !== team) { this.pending.set(player.id, team); this.room.setPlayerTeam(player.id, team); }
    }
    if (this.pending.size === 0) this.movementComplete();
    else {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.reconcile(), 3000);
    }
  }

  reconcile() {
    for (const player of this.room.getPlayerList()) if (this.pending.get(player.id) === player.team) this.pending.delete(player.id);
    if (this.pending.size === 0) this.movementComplete();
    else {
      this.pending.clear();
      this.state = 'LOBBY';
      this.balanceFailures++;
      this.announce(this.balanceFailures >= 3 ? 'Movimento não confirmado; nova tentativa em 30 segundos.' : 'Movimento de times não confirmado; plano será recalculado.', undefined, 'warning');
      this.scheduleBalance();
    }
  }

  movementComplete() {
    clearTimeout(this.pendingTimer);
    if (this.state !== 'PREPARING') return;
    if (this.startTimer) return;
    this.startTimer = setTimeout(() => this.tryStart(), 250);
  }

  tryStart() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.state !== 'PREPARING' || this.pending.size) return;
    if (this.room.getScores?.()) { this.gameStart(null); return; }
    const playing = this.room.getPlayerList().filter(p => p.team === 1 || p.team === 2);
    if (playing.length >= 1) {
      try { this.room.startGame(); }
      catch (error) { console.error(JSON.stringify({ event: 'start_game_failed', error: String(error?.message ?? error).slice(0, 120) })); }
    } else if (this.room.getPlayerList().length === 0) { this.state = 'LOBBY'; return; }
    this.startAttempts++;
    if (this.state !== 'PREPARING') return;
    if (this.startAttempts < 3) this.startTimer = setTimeout(() => this.tryStart(), 1500);
    else {
      this.state = 'LOBBY';
      this.balanceFailures++;
      this.announce(this.balanceFailures >= 3 ? 'Não foi possível iniciar; nova tentativa em 30 segundos.' : 'Não foi possível iniciar a partida; os times serão reconciliados.', undefined, 'warning');
      this.scheduleBalance();
    }
  }

  fillVacancy() {
    this.rebalanceAtReset = false;
    if (this.state !== 'PLAYING') return;
    if (performance.now() - this.lastInMatchBalanceMs < 30_000) { this.rebalanceAtReset = true; return; }
    if ((this.match?.balanceMoves ?? 0) >= 4) return;
    const players = this.room.getPlayerList();
    const red = players.filter(p => p.team === 1).length;
    const blue = players.filter(p => p.team === 2).length;
    if (red === blue) return;
    const reserve = players.find(p => p.team === 0 && performance.now() - (this.lastPlayerMoveMs.get(this.session(p)?.sessionId) ?? -Infinity) >= 120_000);
    if (!reserve) { this.rebalanceAtReset = true; return; }
    const team = red < blue ? 1 : 2;
    this.pending.set(reserve.id, team);
    this.lastInMatchBalanceMs = performance.now();
    this.match.balanceMoves = (this.match.balanceMoves ?? 0) + 1;
    this.room.setPlayerTeam(reserve.id, team);
    this.announce(`Vaga aberta: ${cleanText(reserve.name, 35)} entra no time ${team === 1 ? 'vermelho' : 'azul'}.`);
    this.audit('balance_during_match', this.session(reserve), 'vacancy');
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.reconcileInMatch(), 3000);
  }

  strength(player) {
    const identity = this.session(player)?.playerId;
    const rating = this.ratings[identity];
    return rating?.matches >= 5 ? rating.value : 1000;
  }

  balanceDuringMatch() {
    if (this.state !== 'PLAYING' || !this.match || this.pending.size) return;
    const players = this.room.getPlayerList();
    const red = players.filter(player => player.team === 1);
    const blue = players.filter(player => player.team === 2);
    if (red.length !== blue.length) {
      this.fillVacancy();
      return;
    }
    const redStrength = red.reduce((sum, player) => sum + this.strength(player), 0);
    const blueStrength = blue.reduce((sum, player) => sum + this.strength(player), 0);
    const before = Math.abs(redStrength - blueStrength);
    this.match.imbalanceStreak = before >= 250 ? (this.match.imbalanceStreak ?? 0) + 1 : 0;
    if (this.match.imbalanceStreak < 2 || performance.now() - this.lastInMatchBalanceMs < 30_000 || this.match.balanceMoves >= 4) return;
    let best = null;
    for (const fromRed of red) for (const fromBlue of blue) {
      if (performance.now() - (this.lastPlayerMoveMs.get(this.session(fromRed)?.sessionId) ?? -Infinity) < 120_000) continue;
      if (performance.now() - (this.lastPlayerMoveMs.get(this.session(fromBlue)?.sessionId) ?? -Infinity) < 120_000) continue;
      const after = Math.abs(redStrength - this.strength(fromRed) + this.strength(fromBlue) - (blueStrength - this.strength(fromBlue) + this.strength(fromRed)));
      if (before - after >= 100 && (!best || after < best.after)) best = { fromRed, fromBlue, after };
    }
    if (!best) return;
    this.pending.set(best.fromRed.id, 2);
    this.pending.set(best.fromBlue.id, 1);
    this.room.setPlayerTeam(best.fromRed.id, 2);
    this.room.setPlayerTeam(best.fromBlue.id, 1);
    this.lastInMatchBalanceMs = performance.now();
    this.match.balanceMoves += 2;
    this.match.imbalanceStreak = 0;
    this.announce(`Balanceamento no reset: ${cleanText(best.fromRed.name, 24)} e ${cleanText(best.fromBlue.name, 24)} trocam de time.`);
    this.audit('balance_during_match', null, `cost:${before}->${best.after}`);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.reconcileInMatch(), 3000);
  }

  reconcileInMatch() {
    const players = this.room.getPlayerList();
    for (const [id, team] of this.pending) if (players.some(p => p.id === id && p.team === team)) this.pending.delete(id);
    if (this.pending.size) { this.pending.clear(); this.rebalanceAtReset = true; this.audit('balance_during_match', null, 'unconfirmed'); }
  }

  gameStart(by) {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.state === 'FINALIZING') { this.room.stopGame(); return; }
    if (this.match && !this.match.finished) return;
    this.balanceFailures = 0;
    this.state = 'PLAYING';
    this.match = { matchId: crypto.randomUUID(), startedAt: new Date().toISOString(), stats: new Statistics(), lastTime: 0, finished: false, recording: false, awaitFirstTick: false, balanceMoves: 0, imbalanceStreak: 0, sessions: new Map(this.sessions), participation: new Map(), score: { red: 0, blue: 0, time: 0 } };
    const startedMatchId = this.match.matchId;
    this.match.startPromise = api('/match-start', json({ matchId: this.match.matchId, startedAt: this.match.startedAt }))
      .catch(() => { console.error(JSON.stringify({ event: 'persist_match_start_failed', matchId: startedMatchId })); });
    try { this.room.startRecording(); this.match.recording = true; }
    catch { this.audit('recording', this.session(by), 'start_failed'); }
    this.announce('Partida iniciada!', undefined, 'success');
  }

  tick() {
    const match = this.match;
    if (!match || (this.state !== 'PLAYING' && !match.awaitFirstTick)) return;
    const scores = this.room.getScores();
    if (!scores) return;
    if (match.awaitFirstTick) { match.awaitFirstTick = false; match.lastTime = scores.time; this.state = 'PLAYING'; return; }
    const delta = Math.max(0, Math.min(0.2, scores.time - match.lastTime));
    match.lastTime = scores.time;
    match.score = { red: scores.red, blue: scores.blue, time: scores.time };
    if (!delta) return;
    for (const player of this.room.getPlayerList()) {
      if (player.team !== 1 && player.team !== 2) continue;
      const session = this.session(player);
      if (session) {
        match.sessions.set(player.id, session);
        const participation = match.participation.get(session.sessionId) ?? { red: 0, blue: 0 };
        participation[player.team === 1 ? 'red' : 'blue'] += delta;
        match.participation.set(session.sessionId, participation);
        const stats = match.stats.ensure(session.sessionId);
        stats.activeSeconds += delta;
        if (performance.now() - session.lastActivity > (this.config.afkTimeoutSeconds ?? 60) * 1000) stats.afkSeconds += delta;
      }
    }
  }

  kick(player) {
    if (this.state !== 'PLAYING' || !this.match) return;
    const session = this.session(player);
    if (session) this.match.stats.kick(session.sessionId, player.team, this.match.lastTime);
  }

  goal(team) {
    if (!this.match || ![1, 2].includes(team)) return;
    const inferred = this.match.stats.goal(team, this.match.lastTime);
    this.announce(`Gol ${team === 1 ? 'vermelho' : 'azul'}! ${inferred.scorer ? 'Autor estimado disponível em !stats.' : 'Autor desconhecido.'}`, undefined, 'goal');
  }

  async finish(reason, scores) {
    const match = this.match;
    if (!match || match.finished) return;
    match.finished = true;
    this.state = 'FINALIZING';
    let replay = null;
    try {
      if (match.recording) replay = this.room.stopRecording();
    } catch { this.audit('recording', null, 'stop_failed'); }
    finally { match.recording = false; }
    let replayStatus = 'missing';
    if (replay instanceof Uint8Array && (replay.length < 16 || replay.length > 25_000_000)) replayStatus = 'invalid';
    const actualScores = scores ?? match.score;
    const score = { red: Number(actualScores?.red ?? match.score.red), blue: Number(actualScores?.blue ?? match.score.blue), time: Number(actualScores?.time ?? match.score.time) };
    const matchSessions = [...match.sessions.values()];
    const players = matchSessions.map(s => {
      const duration = match.participation.get(s.sessionId) ?? { red: 0, blue: 0 };
      const team = duration.red > duration.blue ? 1 : duration.blue > duration.red ? 2 : 0;
      return { sessionId: s.sessionId, playerId: s.playerId, connHash: s.connHash ?? null, name: s.name, team, activeSeconds: Math.round(duration.red + duration.blue), afkSeconds: Math.round(match.stats.players.get(s.sessionId)?.afkSeconds ?? 0), teamSeconds: duration, teamTimeline: s.teamTimeline ? [...s.teamTimeline] : [] };
    });
    const observedGoals = match.stats.goals.reduce((totals, goal) => { totals[goal.team]++; return totals; }, { 1: 0, 2: 0 });
    const cleanTeams = players.every(p => !p.teamSeconds.red || !p.teamSeconds.blue);
    const validForRating = reason === 'victory' && score.time >= this.config.minRatingSeconds && observedGoals[1] === score.red && observedGoals[2] === score.blue && cleanTeams && players.filter(p => p.team === 1).length === players.filter(p => p.team === 2).length;
    const record = { matchId: match.matchId, reason, startedAt: match.startedAt, endedAt: new Date().toISOString(), scores: score, players, statistics: match.stats.snapshot(), validForRating, replayStatus, algorithmVersion: 1 };
    this.state = 'LOBBY';
    this.match = null;
    this.scheduleBalance();
    await Promise.allSettled(matchSessions.map(s => s.identityPromise).filter(Boolean));
    players.forEach((player, index) => { player.playerId = matchSessions[index].playerId; player.connHash = matchSessions[index].connHash ?? null; });
    await match.startPromise;
    if (replay instanceof Uint8Array && replayStatus !== 'invalid') {
      try { await api(`/replay/${match.matchId}`, { method: 'POST', body: replay }); record.replayStatus = 'saved'; }
      catch { record.replayStatus = 'failed'; }
    }
    await this.persistFinal(record, record.replayStatus === 'failed' ? replay : null);
  }

  async persistFinal(record, replay) {
    let entry = this.pendingResults.get(record.matchId);
    if (!entry) {
      const pendingReplayBytes = [...this.pendingResults.values()].reduce((total, item) => total + (item.replay?.byteLength ?? 0), 0);
      if (replay && pendingReplayBytes + replay.byteLength > 50_000_000) {
        console.error(JSON.stringify({ event: 'pending_replay_capacity', matchId: record.matchId }));
        replay = null;
      }
      entry = { record, replay, attempts: 0, sending: false };
      this.pendingResults.set(record.matchId, entry);
    }
    if (this.state === 'FINALIZING' && this.match?.matchId === record.matchId) {
      this.state = 'LOBBY';
      this.match = null;
      this.scheduleBalance();
    }
    await this.sendPendingResult(entry);
    this.scheduleResultRetry();
  }

  async sendPendingResult(entry) {
    if (entry.sending || !this.pendingResults.has(entry.record.matchId)) return;
    entry.sending = true;
    try {
      if (entry.replay) {
        try {
          await api(`/replay/${entry.record.matchId}`, { method: 'POST', body: entry.replay });
          entry.record.replayStatus = 'saved';
          entry.replay = null;
        } catch { /* Keep the replay for the next attempt. */ }
      }
      await api('/match', json(entry.record));
      this.pendingResults.delete(entry.record.matchId);
      if (this.pendingResults.size === 0) this.persistOutageNotified = false;
      try { this.ratings = await api('/ratings'); } catch { /* Next successful save refreshes ratings. */ }
      if (this.state === 'LOBBY') this.scheduleBalance();
    } catch (error) {
      entry.attempts++;
      const status = Number.isInteger(error.status) ? error.status : 'rede';
      if (entry.attempts === 1 || entry.attempts % 12 === 0) console.error(JSON.stringify({ event: 'persist_match_failed', matchId: entry.record.matchId, status, attempts: entry.attempts, error: String(error?.message ?? error).slice(0, 120) }));
      if (!this.persistOutageNotified) this.persistOutageNotified = this.notifyAdmins(`Falha ao salvar a partida (${status}); nova tentativa em segundo plano.`) > 0;
    } finally { entry.sending = false; }
  }

  scheduleResultRetry() {
    if (this.retryTimer || this.pendingResults.size === 0) return;
    this.retryTimer = setTimeout(() => { void this.retryPendingResults(); }, 5000);
  }

  async retryPendingResults() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const entry of [...this.pendingResults.values()].slice(0, 3)) await this.sendPendingResult(entry);
    this.scheduleResultRetry();
  }

  isAdmin(session) {
    return session.role === 'owner' || (session.role === 'admin' && (session.adminUntilMs ?? 0) > performance.now());
  }

  notifyAdmins(message) {
    let recipients = 0;
    for (const session of this.sessions.values()) {
      if (!this.isAdmin(session)) continue;
      try { this.announce(message, session.roomPlayerId, 'private'); recipients++; }
      catch (error) { console.error(JSON.stringify({ event: 'admin_notice_failed', error: String(error?.message ?? error).slice(0, 120) })); }
    }
    return recipients;
  }

  async login(session, password) {
    await session.identityPromise;
    if (this.sessions.get(session.roomPlayerId) !== session) return;
    if (!session.loginProof || !password) {
      this.announce('Login indisponível nesta sessão. Entre novamente na sala e tente de novo.', session.roomPlayerId, 'private');
      return;
    }
    try {
      await api('/admin/login', json({ loginProof: session.loginProof, password }));
      if (this.sessions.get(session.roomPlayerId) !== session) return;
      if (session.role !== 'owner') session.role = 'admin';
      session.adminUntilMs = performance.now() + 2 * 60 * 60_000;
      this.announce('Acesso administrativo liberado nesta sessão por 2 horas.', session.roomPlayerId, 'private');
    } catch {
      if (this.sessions.get(session.roomPlayerId) === session) this.announce('Login recusado ou temporariamente bloqueado.', session.roomPlayerId, 'private');
    }
  }

  chat(player, message) {
    const session = this.session(player);
    if (!session) return false;
    const command = parseCommand(message);
    if (!this.chatLimit.take(session.sessionId) || !this.globalChatLimit.take('global')) return false;
    if (!command) return true;
    const privateReply = text => this.announce(text, player.id, 'private');
    const privileged = new Set(['balance', 'start', 'pause', 'end']);
    if (privileged.has(command.name) && !this.isAdmin(session)) {
      this.audit(`command:${command.name}`, session, 'denied');
      privateReply('Comando indisponível.');
      return false;
    }
    switch (command.name) {
      case 'help': privateReply('Comandos: !help, !status, !stats, !meme.'); break;
      case 'login':
        if (command.args.length !== 1) privateReply('Use !login senha.');
        else void this.login(session, command.args[0]);
        break;
      case 'logout':
        if (session.role === 'admin') { session.role = 'player'; session.adminUntilMs = 0; privateReply('Acesso administrativo encerrado.'); }
        else privateReply('Nenhum login administrativo ativo.');
        break;
      case 'adminhelp':
        if (this.isAdmin(session)) privateReply('Admin: !balance, !start, !pause, !end, !logout.');
        else privateReply('Comando indisponível.');
        break;
      case 'status': privateReply(`Estado: ${this.state}. Jogadores: ${this.sessions.size}.`); break;
      case 'stats': {
        const stats = this.match?.stats.players.get(session.sessionId);
        privateReply(stats ? `Toques: ${stats.touches}; gols estimados: ${stats.goals}; assistências estimadas: ${stats.assists}.` : 'Sem estatísticas nesta partida.');
        break;
      }
      case 'meme':
        if (this.memeLimit.take(session.sessionId) && this.globalMemeLimit.take('global')) this.announce(this.memes[this.memeIndex++ % this.memes.length]);
        break;
      case 'balance':
        if (this.state === 'LOBBY') { this.balanceFailures = 0; this.balance(); this.audit('command:balance', session, 'ok'); }
        else privateReply('Balanceamento manual disponível no lobby.');
        break;
      case 'start':
        if (this.state === 'LOBBY') { this.balanceFailures = 0; this.balance(); this.audit('command:start', session, 'ok'); }
        else privateReply('Partida já iniciada ou em preparação.');
        break;
      case 'pause':
        if (this.state === 'PLAYING') { this.room.pauseGame(true); this.audit('command:pause', session, 'ok'); }
        else if (this.state === 'PAUSED') { this.room.pauseGame(false); this.audit('command:pause', session, 'unpause'); }
        break;
      case 'end':
        if (this.state === 'PLAYING' || this.state === 'PAUSED') { this.room.stopGame(); this.audit('command:end', session, 'ok'); }
        break;
      default: privateReply('Comando desconhecido. Use !help.');
    }
    return false;
  }
}

function findHBInit() {
  if (typeof window.HBInit === 'function') return window.HBInit;
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (typeof frame.contentWindow?.HBInit === 'function') return frame.contentWindow.HBInit.bind(frame.contentWindow); }
    catch { /* Cross-origin frame; select it in DevTools instead. */ }
  }
  return undefined;
}

export async function boot(hbInit = findHBInit()) {
  if (typeof hbInit !== 'function') throw new Error('Abra a página oficial Headless e aguarde HBInit.');
  const config = await api('/config');
  const ratings = await api('/ratings');
  const room = hbInit({ roomName: config.roomName, public: config.public, maxPlayers: config.maxPlayers, noPlayer: true, ...(config.token ? { token: config.token } : {}) });
  room.setScoreLimit(config.scoreLimit);
  room.setTimeLimit(config.timeLimit);
  const bot = new Bot(room, config, ratings);
  window.haxballBot = bot;
  return bot;
}
