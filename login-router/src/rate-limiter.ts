import type Database from 'better-sqlite3';

const PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '3', 10);
const PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '20', 10);
const COOLDOWN_SECONDS = parseInt(process.env.RATE_LIMIT_COOLDOWN_SECONDS || '30', 10);
const CLEANUP_DAYS = 7;

let db: Database.Database;

export function initRateLimiter(sharedDb: Database.Database): void {
  db = sharedDb;

  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_item TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rla_vault_item ON rate_limit_attempts(vault_item);
    CREATE INDEX IF NOT EXISTS idx_rla_timestamp ON rate_limit_attempts(timestamp);
  `);

  // Auto-cleanup old entries
  db.exec(`
    DELETE FROM rate_limit_attempts
    WHERE timestamp < datetime('now', '-${CLEANUP_DAYS} days')
  `);
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  reason?: string;
}

export function checkRateLimit(vaultItem: string): RateLimitResult {
  // Check cooldown after recent failures
  const lastFailure = db.prepare(`
    SELECT timestamp FROM rate_limit_attempts
    WHERE vault_item = ? AND success = 0
    ORDER BY id DESC LIMIT 1
  `).get(vaultItem) as { timestamp: string } | undefined;

  if (lastFailure) {
    const failTime = new Date(lastFailure.timestamp + 'Z').getTime();
    const cooldownEnd = failTime + COOLDOWN_SECONDS * 1000;
    const now = Date.now();
    if (now < cooldownEnd) {
      const retryAfter = Math.ceil((cooldownEnd - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: `Cooldown after failure. Retry in ${retryAfter}s`,
      };
    }
  }

  // Check per-minute limit
  const minuteCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM rate_limit_attempts
    WHERE vault_item = ? AND timestamp > datetime('now', '-1 minute')
  `).get(vaultItem) as { cnt: number };

  if (minuteCount.cnt >= PER_MINUTE) {
    return {
      allowed: false,
      retryAfter: 60,
      reason: `Rate limit exceeded: ${PER_MINUTE} attempts per minute`,
    };
  }

  // Check per-hour limit
  const hourCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM rate_limit_attempts
    WHERE vault_item = ? AND timestamp > datetime('now', '-1 hour')
  `).get(vaultItem) as { cnt: number };

  if (hourCount.cnt >= PER_HOUR) {
    return {
      allowed: false,
      retryAfter: 3600,
      reason: `Rate limit exceeded: ${PER_HOUR} attempts per hour`,
    };
  }

  return { allowed: true };
}

export function recordAttempt(vaultItem: string, success: boolean): void {
  db.prepare(`
    INSERT INTO rate_limit_attempts (vault_item, success)
    VALUES (?, ?)
  `).run(vaultItem, success ? 1 : 0);
}
