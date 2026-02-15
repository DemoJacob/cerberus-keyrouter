import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  getActiveAccounts, getAccountById, addAccount, removeAccount as dbRemoveAccount,
  updateAccount, allocatePort, generateId, getSetting, updateSetting, type Account,
} from './config-db.js';

// Encryption key is auto-generated and stored in a file, completely independent
// of VW_ADMIN_TOKEN. This means changing the admin token never affects encrypted data.
const KEY_PATH = process.env.ENCRYPTION_KEY_PATH || '/app/data/encryption.key';

let encryptionKey: Buffer;

function loadOrCreateEncryptionKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    const hex = readFileSync(KEY_PATH, 'utf8').trim();
    console.log('[account-manager] Encryption key loaded from', KEY_PATH);
    return Buffer.from(hex, 'hex');
  }
  // First run — generate a random 256-bit key
  const key = crypto.randomBytes(32);
  writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  console.log('[account-manager] New encryption key generated at', KEY_PATH);
  return key;
}

// --- AES-256-GCM encryption for master passwords ---

export function encryptPassword(plaintext: string): string {
  ensureEncryption();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptPassword(ciphertext: string): string {
  ensureEncryption();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

export function initEncryption(): void {
  if (!encryptionKey) {
    encryptionKey = loadOrCreateEncryptionKey();
  }
}

function ensureEncryption(): void {
  if (!encryptionKey) initEncryption();
}

// --- PBKDF2 double hash (Bitwarden protocol) ---

function pbkdf2(password: Buffer, salt: Buffer, iterations: number, keylen = 32): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function computeMasterPasswordHash(email: string, masterPassword: string, kdfIterations: number): Promise<string> {
  const masterKey = await pbkdf2(
    Buffer.from(masterPassword, 'utf8'),
    Buffer.from(email.toLowerCase(), 'utf8'),
    kdfIterations,
    32,
  );
  const hash = await pbkdf2(
    masterKey,
    Buffer.from(masterPassword, 'utf8'),
    1,
    32,
  );
  return hash.toString('base64');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

// --- bw serve process management ---

interface BwServeInstance {
  process: ChildProcess;
  port: number;
  ready: boolean;
  accountId: string;
}

const instances = new Map<string, BwServeInstance>();

function getVaultwardenUrl(account?: { vaultwarden_url: string | null }): string {
  return account?.vaultwarden_url || getSetting('vaultwarden_url') || 'https://vaultwarden:80';
}

async function waitForBwServe(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`bw serve on port ${port} did not become ready within ${timeoutMs}ms`);
}

async function execBwCommand(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bw', args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`bw ${args.join(' ')} failed (code ${code}): ${stderr.trim() || stdout.trim()}`));
    });
    proc.on('error', reject);
  });
}

export async function startBwServe(account: Account): Promise<void> {
  // Stop existing if running
  await stopBwServe(account.id);

  const vwUrl = getVaultwardenUrl(account);
  const masterPassword = decryptPassword(account.master_password_enc);

  const bwEnv: Record<string, string> = {
    BW_CLIENTID: account.client_id,
    BW_CLIENTSECRET: account.client_secret,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    BITWARDENCLI_APPDATA_DIR: `/tmp/bw-${account.id}`,
  };

  console.log(`[account-manager] Starting bw serve for ${account.email} on port ${account.bw_serve_port}...`);

  // Ensure clean state
  try { await execBwCommand(['logout'], bwEnv); } catch { /* ignore */ }

  // Configure server
  await execBwCommand(['config', 'server', vwUrl], bwEnv);

  // Login with API key
  await execBwCommand(['login', '--apikey'], bwEnv);

  // Start bw serve
  const proc = spawn('bw', ['serve', '--hostname', '127.0.0.1', '--port', String(account.bw_serve_port)], {
    env: { ...process.env, ...bwEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[bw-serve:${account.email}] ${msg}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.warn(`[bw-serve:${account.email}] ${msg}`);
  });

  const instance: BwServeInstance = { process: proc, port: account.bw_serve_port, ready: false, accountId: account.id };
  instances.set(account.id, instance);

  proc.on('close', (code) => {
    console.warn(`[account-manager] bw serve for ${account.email} exited with code ${code}`);
    instances.delete(account.id);
    // Auto-restart after 5 seconds if account still active
    setTimeout(async () => {
      const acc = getAccountById(account.id);
      if (acc && acc.status === 'active' && !instances.has(account.id)) {
        console.log(`[account-manager] Auto-restarting bw serve for ${acc.email}...`);
        try { await startBwServe(acc); } catch (e) {
          console.error(`[account-manager] Failed to restart bw serve for ${acc.email}:`, e);
        }
      }
    }, 5000);
  });

  // Wait for bw serve to be ready
  await waitForBwServe(account.bw_serve_port);
  instance.ready = true;

  // Unlock vault
  const unlockRes = await fetch(`http://127.0.0.1:${account.bw_serve_port}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: masterPassword }),
  });
  const unlockBody = await unlockRes.json() as { success: boolean };
  if (!unlockBody.success) {
    throw new Error(`Failed to unlock vault for ${account.email}`);
  }

  console.log(`[account-manager] bw serve ready for ${account.email} on port ${account.bw_serve_port}`);
}

export async function stopBwServe(accountId: string): Promise<void> {
  const instance = instances.get(accountId);
  if (instance) {
    instance.process.removeAllListeners('close');
    instance.process.kill('SIGTERM');
    instances.delete(accountId);
    // Small delay for process cleanup
    await new Promise(r => setTimeout(r, 500));
  }
}

export function getBwServeStatus(accountId: string): { running: boolean; port?: number } {
  const instance = instances.get(accountId);
  if (!instance) return { running: false };
  return { running: instance.ready, port: instance.port };
}

// --- Account registration (full flow: prelogin → login → get API key) ---

export async function registerAccount(
  email: string,
  masterPassword: string,
  vaultwardenUrl?: string,
  bearerToken?: string,
  displayName?: string,
): Promise<Account> {
  const vwUrl = vaultwardenUrl || getSetting('vaultwarden_url') || 'https://vaultwarden:80';
  const fetchOpts = { headers: {} as Record<string, string> };

  // Step 1: Prelogin
  const preloginRes = await fetch(`${vwUrl}/api/accounts/prelogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!preloginRes.ok) {
    throw new Error(`Prelogin failed: ${preloginRes.status} ${await preloginRes.text()}`);
  }
  const prelogin = await preloginRes.json() as { kdf?: number; Kdf?: number; kdfIterations?: number; KdfIterations?: number };
  const kdfIterations = prelogin.kdfIterations ?? prelogin.KdfIterations ?? 600000;

  // Step 2: Compute master password hash
  const masterPasswordHash = await computeMasterPasswordHash(email, masterPassword, kdfIterations);

  // Step 3: Login with password grant
  const loginParams = new URLSearchParams({
    grant_type: 'password',
    username: email,
    password: masterPasswordHash,
    scope: 'api offline_access',
    client_id: 'web',
    deviceType: '10',
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'cerberus-keyrouter',
  });

  const loginRes = await fetch(`${vwUrl}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginParams.toString(),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${body.slice(0, 300)}`);
  }
  const loginData = await loginRes.json() as { access_token: string };
  const accessToken = loginData.access_token;

  // Extract user UUID from JWT
  const jwtPayload = decodeJwtPayload(accessToken);
  const userUuid = jwtPayload.sub as string;
  const clientId = `user.${userUuid}`;

  // Step 4: Get API key
  const apiKeyRes = await fetch(`${vwUrl}/api/accounts/api-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ masterPasswordHash }),
  });
  if (!apiKeyRes.ok) {
    throw new Error(`Get API key failed: ${apiKeyRes.status} ${await apiKeyRes.text()}`);
  }
  const apiKeyData = await apiKeyRes.json() as { apiKey?: string; ApiKey?: string };
  const clientSecret = apiKeyData.apiKey ?? apiKeyData.ApiKey;
  if (!clientSecret) {
    throw new Error('API key response missing apiKey field');
  }

  // Step 5: Generate bearer token and save
  const token = bearerToken || crypto.randomBytes(32).toString('hex');
  const port = allocatePort();
  const encryptedPassword = encryptPassword(masterPassword);

  const account = addAccount({
    id: generateId(),
    email,
    client_id: clientId,
    client_secret: clientSecret,
    master_password_hash: masterPasswordHash,
    master_password_enc: encryptedPassword,
    bearer_token: token,
    vaultwarden_url: vaultwardenUrl || null,
    display_name: displayName || null,
    bw_serve_port: port,
    status: 'active',
  });

  // Step 6: Start bw serve
  try {
    await startBwServe(account);
  } catch (err) {
    // Cleanup on failure
    dbRemoveAccount(account.id);
    throw new Error(`Account registered but bw serve failed: ${(err as Error).message}`);
  }

  return account;
}

export async function deleteAccount(id: string): Promise<void> {
  await stopBwServe(id);
  dbRemoveAccount(id);
}

export async function restartAccount(id: string): Promise<void> {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account ${id} not found`);
  await startBwServe(account);
}

export async function testAccount(id: string): Promise<{ ok: boolean; message: string }> {
  const account = getAccountById(id);
  if (!account) return { ok: false, message: 'Account not found' };

  const instance = instances.get(id);
  if (!instance?.ready) return { ok: false, message: 'bw serve not running' };

  try {
    const res = await fetch(`http://127.0.0.1:${account.bw_serve_port}/status`);
    if (!res.ok) return { ok: false, message: `bw serve status: ${res.status}` };

    // Try to sync
    const syncRes = await fetch(`http://127.0.0.1:${account.bw_serve_port}/sync`, { method: 'POST' });
    if (!syncRes.ok) return { ok: false, message: `Sync failed: ${syncRes.status}` };

    return { ok: true, message: 'Connected and synced' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// --- Startup: restore all active accounts ---

export async function startAllAccounts(): Promise<void> {
  // Load or create encryption key (independent of admin token)
  initEncryption();

  const accounts = getActiveAccounts();
  if (accounts.length === 0) {
    console.log('[account-manager] No accounts configured');
    return;
  }

  console.log(`[account-manager] Starting ${accounts.length} account(s)...`);
  for (const account of accounts) {
    try {
      await startBwServe(account);
    } catch (err) {
      console.error(`[account-manager] Failed to start ${account.email}:`, (err as Error).message);
    }
  }
}

// --- Legacy migration ---

export async function migrateLegacyEnv(): Promise<string | null> {
  const clientId = process.env.BW_CLIENTID;
  const clientSecret = process.env.BW_CLIENTSECRET;
  const masterPassword = process.env.BW_MASTER_PASSWORD;

  if (!clientId || !clientSecret || !masterPassword) return null;

  // Check if we already have accounts
  const existing = getActiveAccounts();
  if (existing.length > 0) return null;

  console.log('[account-manager] Migrating legacy environment variables...');

  const token = crypto.randomBytes(32).toString('hex');
  const port = allocatePort();

  // We don't know the email from env vars, use a placeholder
  // The user can update it later via the admin frontend
  const userUuid = clientId.replace('user.', '');
  const encryptedPassword = encryptPassword(masterPassword);

  // Compute a dummy hash (we don't know KDF iterations from env)
  // For legacy migration, we'll just store empty hash since we have the password
  const account = addAccount({
    id: generateId(),
    email: `legacy-${userUuid.slice(0, 8)}@migrated`,
    client_id: clientId,
    client_secret: clientSecret,
    master_password_hash: '',
    master_password_enc: encryptedPassword,
    bearer_token: token,
    vaultwarden_url: null,
    display_name: 'Migrated Account',
    bw_serve_port: port,
    status: 'active',
  });

  console.log(`[account-manager] ✓ Legacy account migrated`);
  console.log(`[account-manager]   Bearer token: ${token}`);
  console.log(`[account-manager]   You can now remove BW_CLIENTID, BW_CLIENTSECRET, BW_MASTER_PASSWORD from .env`);

  return token;
}
