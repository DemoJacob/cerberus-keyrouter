# 🐕‍🦺 Cerberus KeyRouter

**Secure login router for AI agents — your LLM never sees your passwords.**

Cerberus KeyRouter is an MCP (Model Context Protocol) server that enables AI agents to log into websites securely. Passwords are stored in Vaultwarden (self-hosted Bitwarden), and the agent only uses `{{placeholder}}` tokens — real credentials are injected locally via Chrome DevTools Protocol (CDP), never entering the LLM context.

## Why?

When AI agents automate browsers, they typically need login credentials in their context window. This means your passwords are:
- Sent to cloud LLM providers (OpenAI, Anthropic, etc.)
- Stored in conversation logs
- Potentially exposed via prompt injection attacks

**Cerberus KeyRouter solves this** by keeping credentials in a local vault and injecting them at the browser level — the LLM only sees `{{email}}` and `{{password}}` placeholders.

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
│    │                                             │
│    ▼                                             │
│  Login Router (localhost:8899)                   │
│    ├─ Fetch credentials from Vaultwarden         │
│    ├─ Replace {{placeholders}} with real values  │
│    ├─ Execute via Chrome CDP                     │
│    ├─ Clear credentials from memory              │
│    └─ Return { status: "ok" } (no passwords)     │
│                                                  │
│  Vaultwarden (Docker, localhost:8443)            │
│    └─ E2E encrypted password storage             │
│                                                  │
│  Chrome (CDP on localhost:18800)                 │
│    └─ Receives fill/click/type commands          │
│                                                  │
└──────────────────────────────────────────────────┘

✅ LLM never sees plaintext passwords
✅ Credentials only exist briefly in login-router memory
✅ All communication is localhost-only
```

## Features

- 🔒 **Zero-knowledge for LLM** — passwords never enter the AI context
- 🏦 **Vaultwarden integration** — self-hosted, E2E encrypted password storage
- 🌐 **MCP protocol** — works with any MCP-compatible AI agent
- 🎭 **Placeholder pattern** — `{{email}}`, `{{password}}`, `{{totp}}`
- ⌨️ **fill & type actions** — `fill` for standard forms, `type` (key-by-key) for React/SPA sites
- 🔍 **Smart tab matching** — finds the correct browser tab by URL
- 📋 **Audit-ready** — credentials are cleared after use, no passwords in logs

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Chrome/Chromium with remote debugging enabled
- An MCP-compatible AI agent (e.g., [OpenClaw](https://github.com/openclaw/openclaw))

### 1. Clone & Configure

```bash
git clone https://github.com/user/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
# Edit .env with your values
```

### 2. Start Services

```bash
docker compose up -d
```

This starts:
- **Vaultwarden** on `https://localhost:8443` — password vault web UI
- **Login Router** on `http://localhost:8899` — MCP server

### 3. Set Up Vaultwarden

1. Open `https://localhost:8443` (accept self-signed cert)
2. Create an account
3. Add login items for your websites
4. Generate API keys (Settings → Security → API Key)
5. Update `.env` with your credentials

### 4. Connect Your AI Agent

Add to your MCP config (e.g., OpenClaw mcporter):

```json
{
  "mcpServers": {
    "cerberus": {
      "baseUrl": "http://localhost:8899/mcp"
    }
  }
}
```

### 5. Start Chrome with CDP

```bash
google-chrome --remote-debugging-port=18800
```

### 6. Test

```bash
# Check health
curl http://localhost:8899/health

# List available logins (no passwords shown)
mcporter call cerberus.list_vault_items

# Secure login
mcporter call cerberus.secure_login --args '{
  "vaultItem": "GitHub",
  "steps": [
    {"action": "fill", "selector": "#login_field", "value": "{{email}}"},
    {"action": "fill", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "[name=commit]"}
  ]
}'
```

## MCP Tools

### `list_vault_items`

Returns available login items (site names + usernames only, **no passwords**).

### `secure_login`

Execute a login sequence with placeholder substitution.

**Parameters:**
- `vaultItem` (string) — Name of the vault item
- `steps` (array) — Ordered browser actions

**Step types:**

| Action | Description | Use Case |
|--------|-------------|----------|
| `fill` | Set value + dispatch events | Standard forms, most sites |
| `type` | Key-by-key input (50ms delay) | React controlled components, SPAs |
| `click` | Click an element | Submit buttons |
| `wait` | Wait for navigation or element | Multi-step logins |
| `select` | Select dropdown option | Select elements |

**Placeholders:** `{{email}}`, `{{username}}`, `{{password}}`, `{{totp}}`

## Multi-Step Login Example (SPA)

Some sites (e.g., banking) have multi-step login flows:

```bash
# Step 1: Enter username
mcporter call cerberus.secure_login --args '{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#username", "value": "{{username}}"},
    {"action": "click", "selector": "#next-btn"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}'

# Step 2: Enter password
mcporter call cerberus.secure_login --args '{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#login-btn"},
    {"action": "wait", "navigation": true}
  ]
}'
```

## Security

- **Passwords never reach the LLM** — only `{{placeholder}}` tokens are in the AI context
- **Credentials cleared after use** — `secureClear()` zeros memory
- **Localhost only** — MCP server binds to `127.0.0.1:8899`
- **Vaultwarden E2E encryption** — even if the database is stolen, data is encrypted
- **Instruction sequences, not scripts** — only predefined actions (fill/type/click/wait/select), no arbitrary JS execution
- **Placeholder injection prevention** — `{{password}}` only allowed in fill/type `value` fields, rejected in selectors

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Prompt injection → login to phishing site | Vaultwarden acts as allowlist; URL verification via CDP |
| Unauthorized MCP access | Bearer token + localhost binding |
| Credential abuse / repeated attempts | Rate limiting + cooldown |
| URL spoofing | CDP reads real browser URL, matches against vault URI |
| Audit gap | Full audit logging (no passwords in logs) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VW_ADMIN_TOKEN` | Vaultwarden admin panel token |
| `BW_CLIENTID` | Bitwarden API client ID |
| `BW_CLIENTSECRET` | Bitwarden API client secret |
| `BW_MASTER_PASSWORD` | Vault master password (for unlock) |
| `CDP_URL` | Chrome DevTools Protocol URL (default: `http://host.docker.internal:18800`) |
| `MCP_PORT` | MCP server port (default: `8899`) |

## Roadmap

- [ ] Human-in-the-loop confirmation (Telegram/Slack approval for sensitive sites)
- [ ] Cookie caching (login once, reuse session)
- [ ] Rate limiting & audit logging
- [ ] Support for OpenClaw snapshot ref IDs (alongside CSS selectors)
- [ ] Web UI for configuration
- [ ] Multi-agent framework support

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

See [LICENSE](LICENSE) for the full text.

**What this means:**
- ✅ Free for personal use, testing, and self-hosting
- ✅ Free to modify and distribute (under the same license)
- ⚠️ If you run a modified version as a network service, you must publish your source code
- 📧 For commercial licensing, contact the author

## Acknowledgments

- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — Self-hosted Bitwarden server
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent framework
- [Playwright](https://playwright.dev/) — Browser automation
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol
