/**
 * Test script: Obtain Vaultwarden user API key programmatically
 *
 * Flow:
 * 1. POST /api/accounts/prelogin → get KDF type & iterations
 * 2. Compute masterPasswordHash (double PBKDF2-SHA256)
 * 3. POST /identity/connect/token (grant_type=password) → get access_token
 * 4. POST /api/accounts/api-key → get apiKey (= client_secret)
 * 5. Extract user UUID from JWT → client_id = "user.{uuid}"
 */

import crypto from 'node:crypto';

// --- Configuration ---
const VW_URL = process.env.VW_URL || 'https://localhost:8443';
const EMAIL = process.env.VW_EMAIL;
const MASTER_PASSWORD = process.env.VW_MASTER_PASSWORD;

if (!EMAIL || !MASTER_PASSWORD) {
  console.error('Usage: VW_EMAIL=xxx VW_MASTER_PASSWORD=xxx node test-api-key.mjs');
  process.exit(1);
}

// Disable TLS verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- Helper functions ---

function pbkdf2(password, salt, iterations, keylen = 32) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

async function computeMasterPasswordHash(email, masterPassword, kdfIterations) {
  // Step 1: masterKey = PBKDF2-SHA256(password=masterPassword, salt=email, rounds=kdfIterations)
  const masterKey = await pbkdf2(
    Buffer.from(masterPassword, 'utf8'),
    Buffer.from(email.toLowerCase(), 'utf8'),
    kdfIterations,
    32
  );

  // Step 2: hash = PBKDF2-SHA256(password=masterKey, salt=masterPassword, rounds=1)
  const hash = await pbkdf2(
    masterKey,
    Buffer.from(masterPassword, 'utf8'),
    1,
    32
  );

  return hash.toString('base64');
}

async function fetchJson(path, options = {}) {
  const url = `${VW_URL}${path}`;
  console.log(`  → ${options.method || 'GET'} ${url}`);
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status}: ${text.substring(0, 500)}`);
    return { ok: false, status: res.status, body: json || text };
  }
  return { ok: true, status: res.status, body: json };
}

// --- Main flow ---

async function main() {
  console.log(`\n=== Testing Vaultwarden API Key Retrieval ===`);
  console.log(`Server: ${VW_URL}`);
  console.log(`Email:  ${EMAIL}\n`);

  // Step 1: Prelogin - get KDF parameters
  console.log('Step 1: Prelogin (get KDF parameters)...');
  const prelogin = await fetchJson('/api/accounts/prelogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });

  if (!prelogin.ok) {
    console.error('Failed at prelogin');
    return;
  }

  const kdfType = prelogin.body.kdf ?? prelogin.body.Kdf;
  const kdfIterations = prelogin.body.kdfIterations ?? prelogin.body.KdfIterations;
  console.log(`  KDF type: ${kdfType}, iterations: ${kdfIterations}\n`);

  // Step 2: Compute master password hash
  console.log('Step 2: Computing master password hash...');
  const masterPasswordHash = await computeMasterPasswordHash(EMAIL, MASTER_PASSWORD, kdfIterations);
  console.log(`  Hash: ${masterPasswordHash.substring(0, 10)}...${masterPasswordHash.substring(masterPasswordHash.length - 5)}\n`);

  // Step 3: Login with password grant
  console.log('Step 3: Login (password grant)...');
  const loginParams = new URLSearchParams({
    grant_type: 'password',
    username: EMAIL,
    password: masterPasswordHash,
    scope: 'api offline_access',
    client_id: 'web',
    deviceType: '10',
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'cerberus-test',
  });

  const login = await fetchJson('/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginParams.toString(),
  });

  if (!login.ok) {
    console.error('Failed at login');
    // Check if 2FA is required
    if (login.body?.TwoFactorProviders) {
      console.log('  ⚠ Two-factor authentication is required!');
      console.log('  Providers:', JSON.stringify(login.body.TwoFactorProviders));
    }
    return;
  }

  const accessToken = login.body.access_token;
  const refreshToken = login.body.refresh_token;
  console.log(`  Access token: ${accessToken.substring(0, 30)}...`);

  // Decode JWT to get user UUID
  const jwtPayload = decodeJwtPayload(accessToken);
  const userUuid = jwtPayload.sub;
  const clientId = `user.${userUuid}`;
  console.log(`  User UUID: ${userUuid}`);
  console.log(`  client_id: ${clientId}\n`);

  // Step 4: Get API key
  console.log('Step 4: Get API key...');
  const apiKeyResult = await fetchJson('/api/accounts/api-key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      masterPasswordHash: masterPasswordHash,
    }),
  });

  if (!apiKeyResult.ok) {
    console.error('Failed to get API key');
    return;
  }

  const apiKey = apiKeyResult.body.apiKey ?? apiKeyResult.body.ApiKey;
  console.log(`  apiKey (= client_secret): ${apiKey}\n`);

  // Summary
  console.log('=== SUCCESS ===');
  console.log(`client_id:     ${clientId}`);
  console.log(`client_secret: ${apiKey}`);
  console.log('');
  console.log('These can be used with:');
  console.log(`  BW_CLIENTID=${clientId}`);
  console.log(`  BW_CLIENTSECRET=${apiKey}`);

  // Step 5: Verify by logging in with the API key
  console.log('\nStep 5: Verify API key login (client_credentials)...');
  const verifyParams = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: apiKey,
    scope: 'api',
    deviceType: '10',
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'cerberus-verify',
  });

  const verify = await fetchJson('/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verifyParams.toString(),
  });

  if (verify.ok) {
    console.log('  ✓ API key login works!\n');
  } else {
    console.log('  ✗ API key login failed\n');
  }
}

main().catch(console.error);
