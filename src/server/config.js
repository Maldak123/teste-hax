import path from 'node:path';

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Configuração inválida: ${name}`);
  return value;
}

export function loadConfig() {
  const hmacKey = process.env.HMAC_KEY;
  const ownerAuth = process.env.OWNER_AUTH;
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const adminPassword = process.env.ADMIN_PASSWORD || null;
  if (!hmacKey || hmacKey.length < 32) throw new Error('HMAC_KEY deve ter ao menos 32 caracteres');
  if (!ownerAuth || ownerAuth.startsWith('replace-')) throw new Error('OWNER_AUTH obrigatório');
  if (!webhook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) throw new Error('DISCORD_WEBHOOK_URL inválido');
  if (adminPassword && (Buffer.byteLength(adminPassword) < 12 || Buffer.byteLength(adminPassword) > 128 || /\s/.test(adminPassword))) throw new Error('ADMIN_PASSWORD deve ter 12 a 128 bytes e não conter espaços');
  return {
    port: integer('PORT', 8787, 1, 65535),
    dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
    hmacKey, ownerAuth, webhook, adminPassword,
    uploadMaxBytes: integer('DISCORD_UPLOAD_MAX_BYTES', 8_000_000, 1_000, 25_000_000),
    replayRetentionDays: integer('REPLAY_RETENTION_DAYS', 30, 1, 365),
    room: {
      roomName: String(process.env.ROOM_NAME ?? 'Sala HaxBall').slice(0, 60),
      public: process.env.ROOM_PUBLIC === 'true',
      maxPlayers: integer('ROOM_MAX_PLAYERS', 30, 2, 30),
      teamSize: integer('TEAM_SIZE', 4, 1, 15),
      scoreLimit: integer('SCORE_LIMIT', 5, 0, 50),
      timeLimit: integer('TIME_LIMIT_MINUTES', 10, 0, 60),
      minRatingSeconds: integer('MIN_RATING_SECONDS', 120, 0, 3600),
      afkTimeoutSeconds: integer('AFK_TIMEOUT_SECONDS', 60, 10, 3600),
      token: process.env.ROOM_TOKEN || undefined
    }
  };
}
