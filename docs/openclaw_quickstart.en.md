# Cerberus KeyRouter × OpenClaw — Quick Start

> Get your AI agent securely logging into websites in 5 minutes — passwords never touch the LLM.

## Prerequisites

| Component | Description |
|-----------|-------------|
| [OpenClaw](https://github.com/openclaw/openclaw) | AI agent framework with browser automation |
| Docker Desktop | Runs Vaultwarden and Login Router |
| [mcporter](https://mcporter.dev) | OpenClaw's recommended MCP client for connecting to external MCP servers (`npm i -g mcporter`) |

## Step 1: Start Cerberus

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
# Edit .env — set VW_ADMIN_TOKEN to any strong secret
docker compose up --build -d
```

Wait ~30 seconds, then verify:

```bash
curl http://localhost:8899/health
# → {"status":"ok"}
```

You now have:
- **Vaultwarden** at `https://localhost:8443` — password vault
- **Login Router** at `http://localhost:8899` — MCP server + admin panel

## Step 2: Initialize the Admin Panel

Open `http://localhost:8899/admin`:

1. Log in with the `VW_ADMIN_TOKEN` from your `.env`
2. You'll be prompted to set a personal password (used for future logins)
3. You're now in the admin dashboard

## Step 3: Create a Vaultwarden Account & Add Passwords

Open `https://localhost:8443` (accept the self-signed certificate):

1. **Create an account** — enter your email and master password
2. **Add login items** — one entry per website:
   - **Name**: short identifier (e.g., `GitHub`, `MyBank`)
   - **Username**: your login email or username
   - **Password**: your site password
   - **URI**: the login page URL (e.g., `https://example.com/login`)

## Step 4: Link Your Account in Admin Panel

Back at `http://localhost:8899/admin`:

1. Click **+ Add Account**
2. Enter your Vaultwarden **email** and **master password**
3. The system automatically fetches your API key, starts `bw serve`, and generates a **Bearer Token**
4. Copy the Bearer Token (click the token cell, or use the **MCP** button to copy a ready-to-use config)

## Step 5: Connect OpenClaw

### 5a. Start the Browser

Ask your agent to launch the browser in an OpenClaw chat:

```
Please start the browser
```

OpenClaw will launch Chrome with its own browser profile (CDP on port 18800). The Login Router injects credentials through this port.

### 5b. Configure MCP Connection

**Option A: Tell the agent directly in chat**

Send something like this in your OpenClaw conversation:

```
Add MCP config:
- Name: cerberus
- URL: http://localhost:8899/mcp
- Bearer Token: <your-bearer-token>
```

The agent will write the config to mcporter's configuration file automatically.

**Option B: Edit the config file manually**

Edit `~/.openclaw/workspace/config/mcporter.json`:

```json
{
  "mcpServers": {
    "cerberus": {
      "baseUrl": "http://localhost:8899/mcp",
      "headers": {
        "Authorization": "Bearer <your-bearer-token>"
      }
    }
  }
}
```

Verify the connection:
```bash
npx mcporter list cerberus
# You should see secure_login and list_vault_items
```

### 5c. Create a Login Skill

A skill tells the agent to use Cerberus for credential filling when it encounters a login page, instead of handling passwords itself.

Create `~/.openclaw/workspace/skills/cerberus-login/SKILL.md` with:

- **Trigger**: Activates when a login page is detected
- **MCP tools**: `list_vault_items` (check available credentials) and `secure_login` (execute login)
- **Flow**: Query vault → Analyze form → Build `{{placeholder}}` steps → Call secure_login → Verify result
- **Safety rules**: Never output passwords, never bypass MCP

Once the skill is in place, the agent will automatically follow this flow whenever it encounters a login page.

## Step 6: Test It!

You can now ask your agent to log into websites securely.

### What the Agent Sees (Safe)

```
User: Log me into example.com

Agent's internal flow:
1. browser open → Navigate to https://example.com/login
2. browser snapshot → See #email, #password fields
3. mcporter call cerberus.list_vault_items → Find matching entry
4. mcporter call cerberus.secure_login → Send {{email}}, {{password}} placeholders
5. browser screenshot → Confirm login success
```

### Actual MCP Call

```bash
npx mcporter call cerberus.secure_login --args '{
  "vaultItem": "example",
  "steps": [
    {"action": "fill", "selector": "#email", "value": "{{email}}"},
    {"action": "fill", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "button[type=submit]"},
    {"action": "wait", "navigation": true}
  ]
}'
```

Response:
```json
{"status": "ok", "message": "All 4 steps completed successfully", "stepsCompleted": 4}
```

**Key point**: The agent only ever sees `{{email}}` and `{{password}}`. Real credentials are injected by the Login Router locally into the browser — the LLM has zero knowledge of your actual passwords.

## fill vs type — Which to Use?

| Action | Behavior | When to Use |
|--------|----------|-------------|
| `fill` | Sets value directly + dispatches input/change events | **Default choice** — works on most sites |
| `type` | Types character by character (50ms delay) | React/Vue controlled components, SPAs that listen for keydown |

**Rule of thumb**: Try `fill` first. If the field appears empty after submission or shows a validation error, switch to `type`.

## Multi-Step Login (Banks, etc.)

Some sites show username and password on separate screens. Split into two calls:

```bash
# Call 1: Enter username + click next
npx mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "#username", "value": "{{username}}"},
    {"action": "click", "selector": "#next-btn"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}'

# Call 2: Enter password + submit
npx mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#login-btn"},
    {"action": "wait", "navigation": true}
  ]
}'
```

## Advanced Features

### Multiple Accounts

Different Vaultwarden accounts get separate Bearer Tokens. Configure multiple MCP servers:

```json
{
  "mcpServers": {
    "cerberus-personal": {
      "baseUrl": "http://localhost:8899/mcp",
      "headers": { "Authorization": "Bearer <personal-token>" }
    },
    "cerberus-work": {
      "baseUrl": "http://localhost:8899/mcp",
      "headers": { "Authorization": "Bearer <work-token>" }
    }
  }
}
```

### Advanced Protection Mode

Enable **Advanced** protection for sensitive accounts in the Admin Panel:
- Each login requires manual approval on the `/approve` page
- Optional Telegram notifications for approval requests
- 50-second timeout — auto-rejects if not approved in time

### Audit Log

Visit `http://localhost:8899/audit` to review all login attempts (success, failure, rate-limited, etc.). No passwords are ever logged.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `secure_login` timeout | Check if the selector is correct; use `browser snapshot` to confirm the element exists |
| Field stays empty after fill | Switch to `type` |
| "No exact match for vault item" | Check vault item name — matching is case-sensitive |
| Wrong tab matched | Ensure the URI in Vaultwarden matches the page domain; restart login-router if needed |
| Connection failed | Check logs: `docker compose logs login-router --tail 20` |

## Architecture Overview

```
OpenClaw Agent
  │
  ├─ browser snapshot/screenshot   ← See page structure (no passwords)
  │
  ├─ mcporter: list_vault_items    ← Check available credentials (no passwords)
  │
  ├─ mcporter: secure_login        ← Send {{placeholder}} steps
  │     │
  │     ▼
  │   Login Router (localhost:8899)
  │     ├─ Bearer Token → Identify account
  │     ├─ Fetch credentials from Vaultwarden
  │     ├─ Replace {{placeholder}} → real values
  │     ├─ Inject into Chrome via CDP
  │     └─ Return {status: "ok"} (no passwords)
  │
  └─ browser screenshot            ← Verify login result
```

**Core principle**: The LLM only ever sees placeholders. Real passwords exist briefly in Login Router memory (cleared immediately after use). The entire chain from Vaultwarden to Chrome stays on your local machine.
