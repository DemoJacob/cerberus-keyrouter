#!/bin/bash
set -e

# Load .env file
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

BW_URL="${BW_URL:-https://localhost:8443}"

# Allow self-signed certs for bw CLI and Node.js
export NODE_TLS_REJECT_UNAUTHORIZED=0

echo "[cerberus] Configuring Bitwarden CLI..."
bw logout 2>/dev/null || true
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

# Wait for bw serve to be responding
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
UNLOCK_RESULT=$(curl -s -X POST "http://127.0.0.1:8087/unlock" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$BW_MASTER_PASSWORD\"}")

if echo "$UNLOCK_RESULT" | grep -q '"success":true'; then
  echo "[cerberus] Vault unlocked successfully"
else
  echo "[cerberus] ERROR: Failed to unlock vault: $UNLOCK_RESULT"
  exit 1
fi

# Clear master password from environment
unset BW_MASTER_PASSWORD

# Verify unlocked status
STATUS=$(curl -s http://127.0.0.1:8087/status)
echo "[cerberus] bw serve status: $(echo $STATUS | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['template']['status'])" 2>/dev/null || echo 'unknown')"

# Cleanup on exit
cleanup() {
  echo "[cerberus] Shutting down..."
  kill $BW_SERVE_PID 2>/dev/null || true
  wait $BW_SERVE_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[cerberus] Starting MCP server..."
cd login-router
exec node dist/index.js
