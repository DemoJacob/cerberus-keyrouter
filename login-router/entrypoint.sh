#!/bin/bash
set -e

# Always start fresh
echo "[cerberus] Ensuring clean login state..."
bw logout 2>/dev/null || true

echo "[cerberus] Configuring Bitwarden CLI..."
bw config server "$BW_URL"

echo "[cerberus] Logging in with API key..."
if ! bw login --apikey 2>&1; then
  echo "[cerberus] ERROR: Login failed"
  exit 1
fi
echo "[cerberus] Login successful"

echo "[cerberus] Starting bw serve on port 8087..."
bw serve --hostname 127.0.0.1 --port 8087 &
BW_SERVE_PID=$!

# Wait for bw serve to start
echo "[cerberus] Waiting for bw serve to start..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8087/status > /dev/null 2>&1; then
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[cerberus] ERROR: bw serve failed to start"
    exit 1
  fi
  sleep 1
done

# Unlock vault via bw serve REST API
echo "[cerberus] Unlocking vault via bw serve..."
UNLOCK_RESULT=$(curl -s --max-time 120 -X POST "http://127.0.0.1:8087/unlock" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${BW_MASTER_PASSWORD}\"}")

if echo "$UNLOCK_RESULT" | grep -q '"success":true'; then
  echo "[cerberus] Vault unlocked successfully"
else
  echo "[cerberus] ERROR: Failed to unlock vault: $UNLOCK_RESULT"
  exit 1
fi

# Clear master password from environment
unset BW_MASTER_PASSWORD

echo "[cerberus] Starting MCP server..."
exec node dist/index.js
