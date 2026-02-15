#!/bin/bash
set -e

echo "[cerberus] Starting MCP server..."
echo "[cerberus] Account management is handled via the admin panel at /admin"

# Legacy support: if BW_CLIENTID is set, account-manager will auto-migrate
if [ -n "$BW_CLIENTID" ]; then
  echo "[cerberus] Legacy env vars detected (BW_CLIENTID). Will auto-migrate on startup."
fi

exec node dist/index.js
