import { scryptSync, timingSafeEqual } from 'node:crypto';

export class AdminAuthenticator {
  constructor(password, clock = () => Date.now()) {
    this.clock = clock;
    this.digest = password ? scryptSync(password, 'bot-haxball-admin-v1', 32) : null;
    this.attempts = new Map();
    this.globalAttempts = [];
  }

  verify(playerId, candidate, authenticated) {
    if (!this.digest || !authenticated || typeof playerId !== 'string') return { ok: false, reason: 'unavailable' };
    const now = this.clock();
    this.globalAttempts = this.globalAttempts.filter(at => now - at < 15 * 60_000);
    if (this.globalAttempts.length >= 50) return { ok: false, reason: 'locked' };
    if (this.attempts.size > 1000) {
      for (const [id, times] of this.attempts) if (times.every(at => now - at >= 15 * 60_000)) this.attempts.delete(id);
    }
    const recent = (this.attempts.get(playerId) ?? []).filter(at => now - at < 15 * 60_000);
    if (recent.length >= 5) return { ok: false, reason: 'locked' };
    const validInput = typeof candidate === 'string' && Buffer.byteLength(candidate) >= 12 && Buffer.byteLength(candidate) <= 128;
    const digest = validInput ? scryptSync(candidate, 'bot-haxball-admin-v1', 32) : Buffer.alloc(32);
    const ok = timingSafeEqual(this.digest, digest);
    if (ok) this.attempts.delete(playerId);
    else { this.attempts.set(playerId, [...recent, now]); this.globalAttempts.push(now); }
    return { ok, reason: ok ? 'ok' : 'denied' };
  }
}
