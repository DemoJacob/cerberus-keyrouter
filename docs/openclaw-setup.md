# Using Cerberus KeyRouter with OpenClaw

This guide covers how to integrate Cerberus KeyRouter with [OpenClaw](https://github.com/openclaw/openclaw) for secure browser login automation.

## Overview

OpenClaw's browser tool provides page snapshots and actions (click, type, navigate). Cerberus KeyRouter adds secure credential injection — the agent analyzes the login page via OpenClaw's browser, then delegates credential filling to the login router via MCP. The LLM never sees plaintext passwords.

```
OpenClaw agent
  ├─ browser.snapshot()        → sees login form structure
  ├─ browser.navigate()        → navigates to login page
  ├─ mcporter: list_vault_items → checks available credentials
  ├─ mcporter: secure_login    → fills credentials via CDP
  └─ browser.screenshot()      → verifies login result
```

## Prerequisites

- OpenClaw installed and running (Gateway active)
- OpenClaw browser enabled (the `openclaw` profile uses Chrome with CDP on port 18800)
- Docker & Docker Compose
- [mcporter](https://mcporter.dev) installed (`npm i -g mcporter`)

## Setup

### 1. Start Cerberus KeyRouter

```bash
cd cerberus-keyrouter
docker compose up -d
```

Verify:

```bash
curl http://localhost:8899/health
# {"status":"ok"}
```

### 2. Configure mcporter

Add Cerberus to your OpenClaw workspace mcporter config:

**File:** `~/.openclaw/workspace/config/mcporter.json`

```json
{
  "mcpServers": {
    "cerberus": {
      "url": "http://localhost:8899/mcp",
      "headers": {
        "Authorization": "Bearer <your-account-bearer-token>"
      }
    }
  }
}
```

Get the bearer token from the admin panel (`http://localhost:8899/admin`) — click the token cell or the **MCP** button to copy a ready-to-use config.

Verify the connection:

```bash
mcporter list cerberus --schema
```

You should see `secure_login` and `list_vault_items` tools.

### 3. Add Credentials to Vaultwarden

1. Open `https://localhost:8443` in your browser
2. Log in (or create an account on first use)
3. Add a login item:
   - **Name**: a short identifier (e.g., `GitHub`, `zooplus`)
   - **Username**: your login email or username
   - **Password**: your password
   - **URI**: the login page URL (e.g., `https://github.com/login`)
4. No restart needed — vault items are queried in real time

## How It Works with OpenClaw

### Typical Flow

1. **Agent navigates** to a website and encounters a login page
2. **Agent takes a snapshot** to understand the form structure
3. **Agent queries vault** via `list_vault_items` to check if credentials exist
4. **Agent constructs steps** using CSS selectors from the snapshot and `{{placeholder}}` tokens
5. **Agent calls `secure_login`** — the login router fetches real credentials from Vaultwarden, replaces placeholders, and executes via CDP
6. **Agent takes another snapshot** to verify the login succeeded

### Example: Standard Login (Single Page)

The agent sees a login form with email and password fields:

```
// Agent calls via mcporter
mcporter call cerberus.secure_login --args '{
  "vaultItem": "zooplus",
  "steps": [
    {"action": "fill", "selector": "#username", "value": "{{email}}"},
    {"action": "fill", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#primary-btn"},
    {"action": "wait", "navigation": true}
  ]
}'
```

### Example: Multi-Step Login (SPA / Banking)

Some sites show username and password on separate screens. Split into multiple calls:

```
// Step 1: Username screen
mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "input[placeholder=\"Enter username\"]", "value": "{{username}}"},
    {"action": "click", "selector": "button:has-text(\"Next\")"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}'

// Step 2: Password screen
mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "input[placeholder=\"Enter password\"]", "value": "{{password}}"},
    {"action": "click", "selector": "button:has-text(\"Login\")"},
    {"action": "wait", "navigation": true}
  ]
}'
```

## fill vs type

| Action | Behavior | When to Use |
|--------|----------|-------------|
| `fill` | Sets the value directly, dispatches `input` and `change` events | Most sites — standard HTML forms, Keycloak, etc. |
| `type` | Types each character with a 50ms delay, triggers `keydown`/`keypress`/`input`/`keyup` per character | Sites with React controlled components or custom input handlers that don't respond to `fill` |

**How to tell which one to use:** Try `fill` first. If the form field appears empty after filling (placeholder still visible) or the submit button reports a validation error, switch to `type`.

## Selector Strategy

When constructing steps, choose selectors in this order:

1. `#id` — most stable (e.g., `#username`, `#password`)
2. `input[name="..."]` — reliable
3. `input[type="password"]` — generic password field
4. `input[placeholder="..."]` — when id/name are dynamically generated
5. `button:has-text("...")` — match buttons by visible text
6. `button[type="submit"]` — generic submit button

Use OpenClaw's `browser snapshot --interactive` or `browser evaluate` to inspect the DOM and find the right selectors.

**Avoid:** Dynamically generated class names (e.g., `d4a07d1c`), XPath expressions.

## OpenClaw Skill (Optional)

If you want the agent to automatically use Cerberus when encountering login pages, create a skill:

**File:** `~/.openclaw/workspace/skills/cerberus-login/SKILL.md`

```markdown
---
name: cerberus-login
description: Securely log into websites using Cerberus KeyRouter MCP.
---

# Cerberus Login Skill

When the browser encounters a login page:
1. Call `list_vault_items` to check for matching credentials
2. Analyze the form with `browser snapshot`
3. Construct steps with {{placeholders}}
4. Call `secure_login`
5. Verify with `browser screenshot`
```

The agent will automatically read this skill when it detects a login page.

## Chrome CDP Configuration

OpenClaw manages Chrome with CDP on port 18800 by default (the `openclaw` browser profile). The login router connects to this same Chrome instance.

**If login-router runs in Docker** (default setup), it connects via `host.docker.internal:18800`. On macOS with Docker Desktop, this works out of the box. On Linux, add to `docker-compose.yml`:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

**If login-router runs on the host** (no Docker for login-router), it connects via `127.0.0.1:18800` directly — no extra configuration needed.

## Troubleshooting

### "locator.fill: Timeout exceeded"

The login router couldn't find the element. Possible causes:
- **Wrong tab**: The login router connected to a different tab. Make sure the vault item's URI matches the page URL domain.
- **Wrong selector**: Use `browser evaluate` to inspect actual element IDs/names.
- **Page not loaded**: Add a `wait` step before `fill`.

### "ECONNRESET" or "appears offline"

The login-router container is restarting or the `bw serve` process hasn't finished initializing. Wait 15–30 seconds and retry. Check logs:

```bash
docker compose logs login-router --tail 20
```

### fill doesn't work (field stays empty)

The site uses a framework (React, Vue, etc.) that overrides direct value setting. Switch from `fill` to `type`.

### Login succeeds but page shows 404

This usually means the OAuth state expired. Navigate to the site's main login URL (e.g., `example.com/account/login` instead of the OAuth redirect URL directly) so the browser gets a fresh session state before calling `secure_login`.
