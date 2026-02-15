import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.CONFIG_DB_PATH || '/app/data/config.db';
const DEFAULT_VW_URL = process.env.DEFAULT_VW_URL || 'https://vaultwarden:80';
const BASE_PORT = 8087;

let db: Database.Database;

export interface Account {
  id: string;
  email: string;
  client_id: string;
  client_secret: string;
  master_password_hash: string;
  master_password_enc: string;
  bearer_token: string;
  vaultwarden_url: string | null;
  display_name: string | null;
  bw_serve_port: number;
  status: string;
  protection_mode: 'standard' | 'advanced';
  created_at: string;
  updated_at: string;
}

export interface PendingApproval {
  id: string;
  account_id: string;
  vault_item: string;
  approval_code: string;
  status: 'pending' | 'approved' | 'expired' | 'rejected';
  created_at: string;
  expires_at: string;
  approved_at: string | null;
}

export function initConfigDb(): Database.Database {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      master_password_hash TEXT NOT NULL,
      master_password_enc TEXT NOT NULL,
      bearer_token TEXT NOT NULL UNIQUE,
      vaultwarden_url TEXT,
      display_name TEXT,
      bw_serve_port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_bearer ON accounts(bearer_token);
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  `);

  // Migration: add protection_mode column if missing
  const columns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'protection_mode')) {
    db.exec("ALTER TABLE accounts ADD COLUMN protection_mode TEXT NOT NULL DEFAULT 'standard'");
    console.log('[config-db] Migrated: added protection_mode column');
  }

  // Pending approvals table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      vault_item TEXT NOT NULL,
      approval_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_approvals(expires_at);
  `);

  // Set default vaultwarden_url if not exists
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('vaultwarden_url');
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('vaultwarden_url', DEFAULT_VW_URL);
  }

  return db;
}

export function getConfigDb(): Database.Database {
  return db;
}

// --- Settings ---

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function updateSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// --- Accounts ---

export function getAccounts(): Account[] {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as Account[];
}

export function getActiveAccounts(): Account[] {
  return db.prepare('SELECT * FROM accounts WHERE status = ? ORDER BY created_at ASC').all('active') as Account[];
}

export function getAccountById(id: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function getAccountByToken(bearerToken: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE bearer_token = ? AND status = ?').get(bearerToken, 'active') as Account | undefined;
}

export function getAccountByEmail(email: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as Account | undefined;
}

export function addAccount(account: Omit<Account, 'created_at' | 'updated_at'>): Account {
  db.prepare(`
    INSERT INTO accounts (id, email, client_id, client_secret, master_password_hash, master_password_enc, bearer_token, vaultwarden_url, display_name, bw_serve_port, status, protection_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id,
    account.email,
    account.client_id,
    account.client_secret,
    account.master_password_hash,
    account.master_password_enc,
    account.bearer_token,
    account.vaultwarden_url,
    account.display_name,
    account.bw_serve_port,
    account.status,
    account.protection_mode || 'standard',
  );
  return getAccountById(account.id)!;
}

export function updateAccount(id: string, updates: Partial<Pick<Account, 'bearer_token' | 'display_name' | 'status' | 'vaultwarden_url' | 'client_id' | 'client_secret' | 'master_password_hash' | 'master_password_enc' | 'protection_mode'>>): Account | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getAccountById(id);

  fields.push('updated_at = datetime(\'now\')');
  values.push(id);

  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getAccountById(id);
}

export function removeAccount(id: string): boolean {
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return result.changes > 0;
}

export function allocatePort(): number {
  const row = db.prepare('SELECT MAX(bw_serve_port) as max_port FROM accounts').get() as { max_port: number | null };
  return (row.max_port ?? (BASE_PORT - 1)) + 1;
}

export function generateId(): string {
  return randomUUID();
}

// --- Pending Approvals ---

export function createPendingApproval(approval: Omit<PendingApproval, 'created_at' | 'approved_at'>): PendingApproval {
  db.prepare(`
    INSERT INTO pending_approvals (id, account_id, vault_item, approval_code, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(approval.id, approval.account_id, approval.vault_item, approval.approval_code, approval.status, approval.expires_at);
  return db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(approval.id) as PendingApproval;
}

export function getPendingApprovalByCode(code: string): PendingApproval | undefined {
  return db.prepare(
    "SELECT * FROM pending_approvals WHERE approval_code = ? AND status = 'pending' AND expires_at > datetime('now')"
  ).get(code) as PendingApproval | undefined;
}

export function getPendingApprovalById(id: string): PendingApproval | undefined {
  return db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as PendingApproval | undefined;
}

export function getPendingApprovals(): PendingApproval[] {
  return db.prepare(
    "SELECT * FROM pending_approvals WHERE status = 'pending' AND expires_at > datetime('now') ORDER BY created_at DESC"
  ).all() as PendingApproval[];
}

export function updateApprovalStatus(id: string, status: 'approved' | 'expired' | 'rejected'): void {
  const approvedAt = status === 'approved' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE pending_approvals SET status = ?, approved_at = ${approvedAt} WHERE id = ?`).run(status, id);
}

export function cleanupExpiredApprovals(): void {
  db.prepare("UPDATE pending_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')").run();
  // Delete old entries (> 24h)
  db.prepare("DELETE FROM pending_approvals WHERE created_at < datetime('now', '-1 day')").run();
}

export function getAdvancedModeAccounts(): Account[] {
  return db.prepare("SELECT * FROM accounts WHERE protection_mode = 'advanced' AND status = 'active' ORDER BY created_at ASC").all() as Account[];
}
