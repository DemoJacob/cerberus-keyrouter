import Database from 'better-sqlite3';

const DB_PATH = process.env.AUDIT_DB_PATH || '/app/data/audit.db';

let db: Database.Database;

export interface AuditEntry {
  action: string;
  vaultItem?: string;
  actualUrl?: string;
  vaultUri?: string;
  urlMatch?: string;
  username?: string;
  result: 'success' | 'error' | 'rate_limited' | 'url_mismatch';
  error?: string;
  stepsCompleted?: number;
  durationMs?: number;
}

export interface AuditQueryFilters {
  page?: number;
  limit?: number;
  vaultItem?: string;
  result?: string;
  from?: string;
  to?: string;
}

export function initAuditDb(): Database.Database {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      vault_item TEXT,
      actual_url TEXT,
      vault_uri TEXT,
      url_match TEXT,
      username TEXT,
      result TEXT NOT NULL,
      error TEXT,
      steps_completed INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_vault_item ON audit_log(vault_item);
    CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result);
  `);

  return db;
}

export function getAuditDb(): Database.Database {
  return db;
}

export function maskUsername(username?: string): string | undefined {
  if (!username) return undefined;

  const atIndex = username.indexOf('@');
  if (atIndex > 0) {
    const local = username.slice(0, atIndex);
    const domain = username.slice(atIndex);
    if (local.length <= 1) return '*' + domain;
    return local[0] + '***' + domain;
  }

  if (username.length <= 2) return '**';
  return username[0] + '***' + username[username.length - 1];
}

export function logAudit(entry: AuditEntry): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log (action, vault_item, actual_url, vault_uri, url_match, username, result, error, steps_completed, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    entry.action,
    entry.vaultItem ?? null,
    entry.actualUrl ?? null,
    entry.vaultUri ?? null,
    entry.urlMatch ?? null,
    entry.username ? maskUsername(entry.username) : null,
    entry.result,
    entry.error?.slice(0, 500) ?? null,
    entry.stepsCompleted ?? null,
    entry.durationMs ?? null,
  );
}

export function queryAuditLogs(filters: AuditQueryFilters): { rows: unknown[]; total: number } {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.vaultItem) {
    conditions.push('vault_item LIKE ?');
    params.push(`%${filters.vaultItem}%`);
  }
  if (filters.result) {
    conditions.push('result = ?');
    params.push(filters.result);
  }
  if (filters.from) {
    conditions.push('timestamp >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('timestamp <= ?');
    params.push(filters.to);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM audit_log ${where}`);
  const { total } = countStmt.get(...params) as { total: number };

  const rowsStmt = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`);
  const rows = rowsStmt.all(...params, limit, offset);

  return { rows, total };
}
