# Cerberus KeyRouter

**Secure login router for AI agents — your LLM never sees your passwords.**

Cerberus KeyRouter is an MCP (Model Context Protocol) server that enables AI agents to log into websites securely. Passwords are stored in Vaultwarden (self-hosted Bitwarden), and the agent only uses `{{placeholder}}` tokens — real credentials are injected locally via Chrome DevTools Protocol (CDP), never entering the LLM context.

## The Problem

When AI agents automate browsers, they typically need login credentials in their context window. This means your passwords are:

- Sent to cloud LLM providers (OpenAI, Anthropic, etc.)
- Stored in conversation logs
- Potentially exposed via prompt injection attacks

Cerberus KeyRouter solves this by keeping credentials in a local vault and injecting them at the browser level — the LLM only sees `{{email}}` and `{{password}}` placeholders.

## Architecture

```
┌─ Your Machine ─────────────────────────────────┐
│                                                  │
│  AI Agent (OpenClaw, etc.)                       │
│    │                                             │
│    │ MCP call: secure_login("GitHub",            │
│    │   steps: [                                  │
│    │     {fill, "#email", "{{email}}"},           │
│    │     {fill, "#password", "{{password}}"},     │
│    │     {click, "#submit"}                      │
│    │   ])                                        │
│    │  + Authorization: Bearer <account-token>     │
│    │                                             │
│    ▼                                             │
│  Login Router (localhost:8899)                   │
│    ├─ Route by bearer token → account            │
│    ├─ Fetch credentials from account's vault     │
│    ├─ Replace {{placeholders}} with real values  │
│    ├─ Execute via Chrome CDP                     │
│    ├─ Clear credentials from memory              │
│    └─ Return { status: "ok" } (no passwords)     │
│                                                  │
│  Admin Panel (localhost:8899/admin)              │
│    └─ Manage accounts, settings, bearer tokens   │
│                                                  │
│  Vaultwarden (Docker, localhost:8443)            │
│    └─ E2E encrypted password storage             │
│                                                  │
│  Chrome (CDP on localhost:18800)                 │
│    └─ Receives fill/click/type commands          │
│                                                  │
└──────────────────────────────────────────────────┘
```

- LLM never sees plaintext passwords
- Credentials only exist briefly in login-router memory
- All communication is localhost-only
- Multiple Vaultwarden accounts supported with isolated vaults

## Features

- **Zero-knowledge for LLM** — passwords never enter the AI context
- **Vaultwarden integration** — self-hosted, E2E encrypted password storage
- **Multi-account support** — manage multiple Vaultwarden accounts, each with its own bearer token
- **Admin panel** — web UI at `/admin` for account management, no manual API key copying needed
- **Auto API key retrieval** — just provide email + master password, API keys are fetched automatically
- **MCP protocol** — works with any MCP-compatible AI agent
- **Placeholder pattern** — `{{email}}`, `{{password}}`, `{{totp}}`
- **fill & type actions** — `fill` for standard forms, `type` (key-by-key) for React/SPA sites
- **Smart tab matching** — finds the correct browser tab by URL
- **Security hardened** — rate limiting, URL verification, audit logging, bearer token auth
- **Audit log** — web UI at `/audit` to review all login attempts (no passwords logged)

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Chrome/Chromium with remote debugging enabled (`--remote-debugging-port=18800`)
- An MCP-compatible AI agent (e.g., [OpenClaw](https://github.com/openclaw/openclaw))

### 1. Clone & Initial Config

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
```

Edit `.env` — only one variable is required:

```bash
VW_ADMIN_TOKEN=your_admin_password_here
```

This token protects the admin panel and is used to encrypt stored passwords.

### 2. Start Vaultwarden

```bash
docker compose up -d vaultwarden
```

Wait until healthy, then open `https://localhost:8443` (accept the self-signed certificate).

### 3. Set Up Vaultwarden

1. Create an account (set your master password)
2. Add login items for your websites (name, username, password, URI)

> **Note:** By default `SIGNUPS_ALLOWED=false` in `docker-compose.yml`. For first-time setup, change it to `true`, restart Vaultwarden, create your account, then change it back. Keeping it `true` is fine for personal/local use since the service is only accessible on localhost.

### 4. Start All Services

```bash
docker compose up --build -d
```

This starts:
- **Vaultwarden** on `https://localhost:8443` — password vault web UI
- **Login Router** on `http://localhost:8899` — MCP server + admin panel

Verify: `curl http://localhost:8899/health` should return `{"status":"ok"}`

### 5. Add Your Account via Admin Panel

Open `http://localhost:8899/admin` and log in with your `VW_ADMIN_TOKEN`.

1. (Optional) Update the **Vaultwarden URL** if using a custom domain or reverse proxy
2. Click **+ Add Account**
3. Enter your Vaultwarden **email** and **master password**
4. The system will automatically:
   - Connect to Vaultwarden
   - Fetch your API key (client_id + client_secret)
   - Start a dedicated `bw serve` process
   - Generate a unique **bearer token** for MCP calls
5. Copy the bearer token — you'll need it for your AI agent config

No manual API key copying needed! The admin panel handles everything.

### 6. Connect Your AI Agent

Add to your MCP configuration, using the bearer token from step 5:

```json
{
  "mcpServers": {
    "cerberus": {
      "baseUrl": "http://localhost:8899/mcp",
      "headers": {
        "Authorization": "Bearer <your-account-bearer-token>"
      }
    }
  }
}
```

### 7. Test

```bash
# Check health
curl http://localhost:8899/health

# List available logins (no passwords shown)
# Replace <TOKEN> with your account's bearer token
curl http://localhost:8899/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Admin Panel

Access at `http://localhost:8899/admin` (login with `VW_ADMIN_TOKEN`).

**Features:**
- **Settings** — configure default Vaultwarden URL (supports custom domains / reverse proxies)
- **Accounts** — add, test, restart, disable, or delete Vaultwarden accounts
- **Bearer tokens** — each account gets a unique token; click to copy
- **bw serve status** — see which accounts are running

**Adding multiple accounts:**
Each account gets its own `bw serve` process on a unique port, fully isolated. Different AI agents (or different users) can use different bearer tokens to access different vaults.

## MCP Tools

### `list_vault_items`

Returns available login items — site names and usernames only, **no passwords**.

### `secure_login`

Execute a login sequence with placeholder substitution.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `vaultItem` | string | Name of the vault item to use |
| `steps` | array | Ordered list of browser actions |

**Step types:**

| Action | Description | Use Case |
|--------|-------------|----------|
| `fill` | Set value + dispatch input/change events | Standard forms, most sites |
| `type` | Key-by-key input (50ms delay) | React controlled components, SPAs |
| `click` | Click an element | Submit buttons |
| `wait` | Wait for navigation or selector | Page transitions, multi-step flows |
| `select` | Select a dropdown option | Select elements |

**Placeholders:** `{{email}}`, `{{username}}`, `{{password}}`, `{{totp}}`

## Multi-Step Login (SPA)

Some sites have multi-step login flows. Handle these by splitting into separate calls:

```json
// Step 1: Enter username, proceed to password screen
{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#username", "value": "{{username}}"},
    {"action": "click", "selector": "#next-btn"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}

// Step 2: Enter password, submit
{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#login-btn"},
    {"action": "wait", "navigation": true}
  ]
}
```

## Security

### Design Principles

- **Passwords never reach the LLM** — only `{{placeholder}}` tokens exist in the AI context
- **Credentials cleared after use** — memory is zeroed immediately after injection
- **Localhost only** — MCP server binds to `0.0.0.0:8899` inside Docker, exposed only on localhost
- **Vaultwarden E2E encryption** — data at rest is encrypted; without the master password, it's unreadable
- **AES-256-GCM encryption** — stored master passwords are encrypted with the admin token as key
- **Instruction sequences, not scripts** — only predefined actions (fill/type/click/wait/select), no arbitrary JS execution
- **Placeholder injection prevention** — `{{password}}` is only allowed in fill/type `value` fields; rejected in selectors

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Prompt injection → login to phishing site | Vaultwarden acts as implicit allowlist; URL verification via CDP |
| Unauthorized MCP access | Per-account bearer token authentication |
| Credential abuse / repeated attempts | Rate limiting (3/min, 20/hr) + cooldown after failures |
| URL spoofing | Login router reads actual browser URL via CDP, matches against vault URI |
| Missing audit trail | Structured audit logging at `/audit` (no passwords in logs) |
| Stored password leakage | Master passwords encrypted with AES-256-GCM (key = admin token) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VW_ADMIN_TOKEN` | Yes | Admin panel password + encryption key for stored master passwords |
| `RATE_LIMIT_PER_MINUTE` | No | Max login attempts per vault item per minute (default: 3) |
| `RATE_LIMIT_PER_HOUR` | No | Max login attempts per vault item per hour (default: 20) |
| `RATE_LIMIT_COOLDOWN_SECONDS` | No | Cooldown after failed attempt (default: 30) |

All other configuration (Vaultwarden URL, accounts, bearer tokens) is managed via the admin panel.

### Upgrading from v0.1

If you're upgrading from the previous version with `BW_CLIENTID`, `BW_CLIENTSECRET`, and `BW_MASTER_PASSWORD` in `.env`:

- These are **auto-migrated** on first start — a new account is created in the config DB with a generated bearer token (printed to logs)
- After migration, you can remove these variables from `.env`
- Re-add the account properly via the admin panel with the correct email for best results

## Roadmap

- [ ] Human-in-the-loop confirmation (approval via Telegram/Slack for sensitive sites)
- [ ] Cookie caching (login once, reuse session)
- [ ] Support for OpenClaw snapshot ref IDs (alongside CSS selectors)
- [ ] Multi-agent framework support

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [LICENSE](LICENSE) for the full text.

- Free for personal use, testing, and self-hosting
- Free to modify and distribute under the same license
- If you run a modified version as a network service, you must publish your source code
- For commercial licensing, contact the author

## Acknowledgments

- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — Self-hosted Bitwarden server
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent framework
- [Playwright](https://playwright.dev/) — Browser automation
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol
