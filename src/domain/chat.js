export class RateLimiter {
  constructor({ capacity = 4, refillMs = 2000, clock = () => performance.now() } = {}) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.clock = clock;
    this.buckets = new Map();
  }
  take(key) {
    const now = this.clock();
    const old = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    const tokens = Math.min(this.capacity, old.tokens + Math.max(0, now - old.at) / this.refillMs);
    this.buckets.set(key, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }
  delete(key) { this.buckets.delete(key); }
}

export function parseCommand(message, prefix = '!') {
  if (typeof message !== 'string' || !message.startsWith(prefix)) return null;
  const words = message.slice(prefix.length, 201).trim().split(/\s+/);
  return { name: (words.shift() ?? '').toLowerCase(), args: words.slice(0, 8) };
}

export function cleanText(value, max = 120) {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f@`<>]/g, ' ').trim().slice(0, max);
}
