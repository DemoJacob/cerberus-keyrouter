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
- **Admin panel** — web UI at `/admin` for account management, with session-based auth and password protection
- **Auto API key retrieval** — just provide email + master password, API keys are fetched automatically
- **MCP protocol** — works with any MCP-compatible AI agent
- **Placeholder pattern** — `{{email}}`, `{{password}}`, `{{totp}}`
- **fill & type actions** — `fill` for standard forms, `type` (key-by-key) for React/SPA sites
- **Smart tab matching** — finds the correct browser tab by URL and CSS selector detection
- **Two-tier protection** — Standard mode (auto-unlock) or Advanced mode (manual unlock + Telegram approval)
- **Telegram integration** — real-time notifications for unlock events, approval requests with confirmation codes, and login execution results
- **Mobile-friendly approval page** — `/approve` page for unlocking vaults and approving login requests on the go
- **Security hardened** — rate limiting, URL verification, audit logging, bearer token auth
- **Audit log** — web UI at `/audit` to review all login attempts (no passwords logged)

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Chrome/Chromium with remote debugging enabled (`--remote-debugging-port=18800`)
- An MCP-compatible AI agent (e.g., [OpenClaw](https://github.com/openclaw/openclaw))

### 1. Clone & Configure

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
```

Edit `.env` — only one variable is required:

```bash
VW_ADMIN_TOKEN=your-secret-token-here
```

This token is used for initial admin login and as a fallback for password reset.

### 2. Start Services

```bash
docker compose up --build -d
```

This starts:
- **Vaultwarden** on `https://localhost:8443` — password vault
- **Login Router** on `http://localhost:8899` — MCP server + admin panel

Verify: `curl http://localhost:8899/health` should return `{"status":"ok"}`

### 3. Create a Vaultwarden Account

Open `https://localhost:8443` in your browser (accept the self-signed certificate).

1. Click **Create Account**
2. Set your email and master password
3. Log in and add login items for your websites (name, username, password, URI)

### 4. Set Up Admin Panel

Open `http://localhost:8899/admin`:

1. **First login** — enter your `VW_ADMIN_TOKEN` from `.env`
2. **Set admin password** — a dialog will prompt you to create a personal password (min 8 characters). After this, `VW_ADMIN_TOKEN` can no longer be used for admin login
3. Future logins use your new password

> **Forgot password?** Click the "Forgot password?" link on the login page and enter your `VW_ADMIN_TOKEN` to reset.

### 5. Add Your Vaultwarden Account

In the admin panel:

1. (Optional) Update the **Vaultwarden URL** if using a custom domain
2. Click **+ Add Account**
3. Enter your Vaultwarden **email** and **master password**
4. The system will automatically:
   - Connect to Vaultwarden and fetch your API key
   - Start a dedicated `bw serve` process
   - Generate a unique **bearer token** for MCP calls
5. Copy the bearer token (click the token cell or use the **MCP** button to copy a ready-to-use MCP config)

### 6. Connect Your AI Agent

Add to your MCP configuration:

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

### 7. Test

```bash
# Check health
curl http://localhost:8899/health

# List available logins (no passwords shown)
curl http://localhost:8899/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Admin Panel

Access at `http://localhost:8899/admin`.

**Authentication:**
- First login uses `VW_ADMIN_TOKEN`, then you set a personal password (PBKDF2-SHA256 hashed)
- Sessions last 8 hours
- Password can be changed anytime from Settings
- Forgot password? Reset with `VW_ADMIN_TOKEN` on the login page

**Features:**
- **Settings** — configure default Vaultwarden URL, Telegram notifications
- **Accounts** — add, test, restart, disable, or delete Vaultwarden accounts
- **Bearer tokens** — each account gets a unique token; click to copy
- **MCP config** — one-click copy of ready-to-use MCP JSON config
- **Protection modes** — Standard (auto-unlock) or Advanced (manual unlock + Telegram approval)
- **Unlock / Lock** — unlock or lock advanced-mode accounts directly from the account list
- **bw serve status** — see which accounts are running

**Additional pages:**
- `/approve` — mobile-friendly page for unlocking advanced-mode accounts and approving login requests
- `/audit` — searchable audit log of all login attempts

## Protection Modes

Each Vaultwarden account can be configured with one of two protection levels:

### Standard Mode (default)

- Vault is **auto-unlocked** on server startup
- Login requests are executed immediately
- Best for low-risk accounts or development use

### Advanced Mode

- Vault stays **locked** until manually unlocked via the `/approve` page or the admin panel
- Every `secure_login` call requires **real-time approval** with a 4-digit confirmation code
- Approval must be completed within **50 seconds** or the request is automatically rejected
- Best for sensitive accounts (banking, financial services, etc.)

### Telegram Notifications

When Telegram is configured (bot token + chat ID in Settings), Advanced mode accounts receive:

1. **Unlock notification** — when a vault is successfully unlocked
2. **Approval request** — when an agent calls `secure_login`, including the vault item name and a 4-digit confirmation code
3. **Execution result** — whether the login succeeded or failed after approval

This creates a human-in-the-loop flow: the AI agent requests a login, you verify the request on your phone, enter the confirmation code on the `/approve` page, and the login proceeds.

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
- **AES-256-GCM encryption** — stored master passwords are encrypted with an auto-generated key (independent of admin token)
- **PBKDF2-SHA256 admin password** — admin panel password is hashed with 310k iterations, never stored in plaintext
- **Session-based auth** — admin API uses server-side sessions (8h TTL), not raw tokens
- **Instruction sequences, not scripts** — only predefined actions (fill/type/click/wait/select), no arbitrary JS execution
- **Placeholder injection prevention** — `{{password}}` is only allowed in fill/type `value` fields; rejected in selectors

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Prompt injection to login to phishing site | Vaultwarden acts as implicit allowlist; URL verification via CDP |
| Unauthorized MCP access | Per-account bearer token authentication |
| Credential abuse / repeated attempts | Rate limiting (3/min, 20/hr) + cooldown after failures |
| Unauthorized login to sensitive accounts | Advanced mode: manual unlock + confirmation code approval with 50s timeout |
| URL spoofing | Login router reads actual browser URL via CDP, matches against vault URI |
| Missing audit trail | Structured audit logging at `/audit` (no passwords in logs) |
| Stored password leakage | Master passwords encrypted with AES-256-GCM (auto-generated key) |
| Admin panel brute force | PBKDF2-SHA256 hashed password, session-based auth |
| Unnoticed credential use | Telegram notifications for unlock, approval requests, and execution results |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VW_ADMIN_TOKEN` | Yes | Initial admin login token and password reset fallback |

All other configuration (Vaultwarden URL, accounts, bearer tokens, Telegram, rate limiting) is managed via the admin panel or has sensible defaults in `docker-compose.yml`.

## Roadmap

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
