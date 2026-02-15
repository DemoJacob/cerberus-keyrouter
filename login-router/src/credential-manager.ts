import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Credentials } from './placeholder.js';

const execFileAsync = promisify(execFile);

const USE_BW_EXEC = process.env.USE_BW_EXEC === 'true';

interface BwItem {
  id: string;
  name: string;
  type: number;
  login?: {
    username?: string;
    password?: string;
    totp?: string;
    uris?: Array<{ uri: string }>;
  };
}

interface BwListResponse {
  success: boolean;
  data: { data: BwItem[] };
}

interface BwObjectResponse {
  success: boolean;
  data: { data: string };
}

// --- bw serve REST API (primary) ---

function bwServeUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function bwServeSync(port: number): Promise<void> {
  const res = await fetch(`${bwServeUrl(port)}/sync`, { method: 'POST' });
  if (!res.ok) {
    console.warn('bw serve sync failed:', res.status);
  }
}

async function bwServeGet<T>(port: number, path: string): Promise<T> {
  const res = await fetch(`${bwServeUrl(port)}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bw serve error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function getCredentialsViaServe(vaultItemName: string, port: number): Promise<Credentials> {
  await bwServeSync(port);
  const searchRes = await bwServeGet<BwListResponse>(
    port,
    `/list/object/items?search=${encodeURIComponent(vaultItemName)}`
  );

  const items = searchRes.data?.data;
  if (!items || items.length === 0) {
    throw new Error(`No vault item found matching "${vaultItemName}"`);
  }

  // Exact name match
  const item = items.find(i => i.name === vaultItemName);
  if (!item) {
    throw new Error(`No exact match for vault item "${vaultItemName}". Found: ${items.map(i => i.name).join(', ')}`);
  }

  const credentials: Credentials = {};

  // Store URI from the item for tab matching
  credentials.uri = item.login?.uris?.[0]?.uri;

  // Get username
  try {
    const usernameRes = await bwServeGet<BwObjectResponse>(port, `/object/username/${item.id}`);
    credentials.username = usernameRes.data?.data;
  } catch { /* optional field */ }

  // Get password
  try {
    const passwordRes = await bwServeGet<BwObjectResponse>(port, `/object/password/${item.id}`);
    credentials.password = passwordRes.data?.data;
  } catch { /* optional field */ }

  // Get TOTP
  try {
    const totpRes = await bwServeGet<BwObjectResponse>(port, `/object/totp/${item.id}`);
    credentials.totp = totpRes.data?.data;
  } catch { /* optional field - not all items have TOTP */ }

  if (!credentials.username && !credentials.password) {
    throw new Error(`Vault item "${vaultItemName}" has no username or password`);
  }

  return credentials;
}

async function listItemsViaServe(port: number): Promise<Array<{ name: string; username?: string; uri?: string }>> {
  await bwServeSync(port);
  const res = await bwServeGet<BwListResponse>(port, '/list/object/items');
  const items = res.data?.data ?? [];

  return items
    .filter(item => item.type === 1) // Login type only
    .map(item => ({
      name: item.name,
      username: item.login?.username,
      uri: item.login?.uris?.[0]?.uri,
    }));
}

// --- bw CLI exec (fallback) ---

async function bwExec(args: string[]): Promise<string> {
  const sessionKey = process.env.BW_SESSION;
  const fullArgs = sessionKey ? [...args, '--session', sessionKey] : args;

  const { stdout } = await execFileAsync('bw', fullArgs, {
    timeout: 15_000,
    env: { ...process.env },
  });
  return stdout.trim();
}

async function getCredentialsViaExec(vaultItemName: string): Promise<Credentials> {
  const credentials: Credentials = {};

  try {
    credentials.username = await bwExec(['get', 'username', vaultItemName]);
  } catch { /* optional */ }

  try {
    credentials.password = await bwExec(['get', 'password', vaultItemName]);
  } catch { /* optional */ }

  try {
    credentials.totp = await bwExec(['get', 'totp', vaultItemName]);
  } catch { /* optional */ }

  if (!credentials.username && !credentials.password) {
    throw new Error(`Vault item "${vaultItemName}" has no username or password`);
  }

  return credentials;
}

async function listItemsViaExec(): Promise<Array<{ name: string; username?: string; uri?: string }>> {
  const raw = await bwExec(['list', 'items']);
  const items: BwItem[] = JSON.parse(raw);

  return items
    .filter(item => item.type === 1)
    .map(item => ({
      name: item.name,
      username: item.login?.username,
      uri: item.login?.uris?.[0]?.uri,
    }));
}

// --- Public API ---

export async function getCredentials(vaultItemName: string, bwServePort?: number): Promise<Credentials> {
  if (USE_BW_EXEC) {
    return getCredentialsViaExec(vaultItemName);
  }
  return getCredentialsViaServe(vaultItemName, bwServePort ?? 8087);
}

export async function listItems(bwServePort?: number): Promise<Array<{ name: string; username?: string; uri?: string }>> {
  if (USE_BW_EXEC) {
    return listItemsViaExec();
  }
  return listItemsViaServe(bwServePort ?? 8087);
}
