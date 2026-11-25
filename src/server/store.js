import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(dir, hmacKey, minRatingSeconds = 120, replayRetentionDays = 30) {
    this.dir = dir;
    this.hmacKey = hmacKey;
    this.minRatingSeconds = minRatingSeconds;
    this.replayRetentionDays = replayRetentionDays;
    this.state = { version: 1, matches: {}, activeMatches: {}, interruptedMatches: {}, replays: {}, outbox: {}, ratings: {}, identities: {}, audits: [] };
    this.serial = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.dir, 'replays'), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state.activeMatches ??= {};
    this.state.interruptedMatches ??= {};
    for (const [matchId, active] of Object.entries(this.state.activeMatches)) {
      this.state.interruptedMatches[matchId] = { ...active, interruptedAt: new Date().toISOString(), reason: 'process_restart' };
    }
    this.state.activeMatches = {};
    for (const item of Object.values(this.state.outbox)) {
      if (item.status === 'sending') item.status = 'uncertain';
    }
    await this.save();
    await this.prune();
  }

  hash(value) { return createHmac('sha256', this.hmacKey).update(value).digest('hex'); }

  loginProof(playerId) {
    const payload = Buffer.from(JSON.stringify({ playerId, expiresAt: Date.now() + 2 * 60 * 60_000 })).toString('base64url');
    return `${payload}.${this.hash(`login:${payload}`)}`;
  }

  verifyLoginProof(proof) {
    if (typeof proof !== 'string' || proof.length > 512) return null;
    const [payload, signature, extra] = proof.split('.');
    if (!payload || !/^[a-f0-9]{64}$/.test(signature ?? '') || extra !== undefined) return null;
    const expected = Buffer.from(this.hash(`login:${payload}`), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
    try {
      const { playerId, expiresAt } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (typeof playerId !== 'string' || !this.state.identities[playerId] || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      return playerId;
    } catch { return null; }
  }

  async save() {
    const name = path.join(this.dir, `state-${randomUUID()}.tmp`);
    await writeFile(name, JSON.stringify(this.state), { mode: 0o600 });
    await rename(name, path.join(this.dir, 'state.json'));
  }

  update(fn) {
    const operation = this.serial.then(async () => {
      const before = structuredClone(this.state);
      try { const result = await fn(this.state); await this.save(); return result; }
      catch (error) { this.state = before; throw error; }
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async identity(auth, conn, name, ownerAuth) {
    const authHash = typeof auth === 'string' && auth ? this.hash(`auth:${auth}`) : null;
    const connHash = typeof conn === 'string' && conn ? this.hash(`conn:${conn}`) : null;
    const playerId = authHash ? `p-${authHash.slice(0, 24)}` : `guest-${randomUUID()}`;
    const role = auth && auth === ownerAuth ? 'owner' : 'player';
    await this.update(state => {
      const previous = state.identities[playerId];
      state.identities[playerId] = { playerId, authHash, displayNameLast: String(name ?? '').slice(0, 40), createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    });
    return { playerId, role, connHash, authenticated: authHash !== null, loginProof: this.loginProof(playerId) };
  }

  async replay(matchId, bytes) {
    if (!/^[\w-]{1,80}$/.test(matchId) || !(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > 25_000_000) throw new Error('Replay inválido');
    if (this.state.matches[matchId]) throw new Error('Partida já finalizada');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const existing = this.state.replays?.[matchId];
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('Replay conflitante');
      return existing;
    }
    const file = path.join(this.dir, 'replays', `${matchId}.hbr2`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, file);
    const metadata = { checksum, size: bytes.length, file, status: 'saved', retentionAt: new Date(Date.now() + this.replayRetentionDays * 86_400_000).toISOString() };
    await this.update(state => { state.replays ??= {}; state.replays[matchId] = metadata; });
    return metadata;
  }

  async commitMatch(match) {
    if (!match || !/^[\w-]{1,80}$/.test(match.matchId) || !['victory', 'stopped', 'aborted'].includes(match.reason)) throw new Error('Partida inválida');
    if (!match.scores || !Number.isInteger(match.scores.red) || !Number.isInteger(match.scores.blue) || match.scores.red < 0 || match.scores.blue < 0 || !Number.isFinite(match.scores.time) || match.scores.time < 0) throw new Error('Placar inválido');
    if (!Array.isArray(match.players) || match.players.length > 200 || !match.players.every(player => [0, 1, 2].includes(player.team) && Number.isFinite(player.activeSeconds) && player.activeSeconds >= 0)) throw new Error('Participação inválida');
    const observedGoals = { 1: 0, 2: 0 };
    for (const goal of match.statistics?.goals ?? []) {
      if (![1, 2].includes(goal.team)) throw new Error('Evento de gol inválido');
      observedGoals[goal.team]++;
    }
    const ratingsAllowed = match.validForRating === true && match.reason === 'victory' && match.scores.time >= this.minRatingSeconds && observedGoals[1] === match.scores.red && observedGoals[2] === match.scores.blue && match.players.every(player => !(player.teamSeconds?.red > 0 && player.teamSeconds?.blue > 0));
    return this.update(state => {
      if (state.matches[match.matchId]) return false;
      state.matches[match.matchId] = { ...match, validForRating: ratingsAllowed, replay: state.replays?.[match.matchId] ?? { status: 'missing' } };
      delete state.activeMatches[match.matchId];
      delete state.interruptedMatches[match.matchId];
      const key = `match-result:${match.matchId}`;
      state.outbox[key] = { key, matchId: match.matchId, status: 'pending', attempts: 0, nextAt: 0, lastError: null };
      if (ratingsAllowed) {
        const winningTeam = match.scores.red > match.scores.blue ? 1 : match.scores.blue > match.scores.red ? 2 : 0;
        if (winningTeam) {
          const byIdentity = new Map();
          for (const player of match.players) {
            if (!player.playerId || ![1, 2].includes(player.team)) continue;
            const item = byIdentity.get(player.playerId) ?? { team: player.team, seconds: 0, mixed: false };
            item.seconds += Number(player.activeSeconds) || 0;
            item.mixed ||= item.team !== player.team;
            byIdentity.set(player.playerId, item);
          }
          for (const [playerId, item] of byIdentity) {
            if (item.mixed || item.seconds < 30) continue;
            const rating = state.ratings[playerId] ?? { value: 1000, matches: 0 };
            rating.value += item.team === winningTeam ? 16 : -16;
            rating.matches++;
            state.ratings[playerId] = rating;
          }
        }
      }
      return true;
    });
  }

  startMatch(matchId, startedAt) {
    if (!/^[\w-]{1,80}$/.test(matchId) || !Number.isFinite(Date.parse(startedAt))) throw new Error('Início inválido');
    return this.update(state => {
      if (!state.matches[matchId]) state.activeMatches[matchId] = { matchId, startedAt };
    });
  }

  audit(entry) {
    return this.update(state => {
      state.audits.push({ ...entry, at: new Date().toISOString() });
      if (state.audits.length > 5000) state.audits.splice(0, state.audits.length - 5000);
    });
  }

  prune() {
    return this.update(async state => {
      for (const [matchId, replay] of Object.entries(state.replays ?? {})) {
        if (replay.status !== 'saved' || !replay.retentionAt || Date.parse(replay.retentionAt) > Date.now()) continue;
        if (state.outbox[`match-result:${matchId}`]?.status !== 'sent') continue;
        try { await unlink(replay.file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        replay.status = 'expired';
        if (state.matches[matchId]?.replay) state.matches[matchId].replay.status = 'expired';
      }
    });
  }
}
