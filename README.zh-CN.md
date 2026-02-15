# Cerberus KeyRouter

**AI Agent 安全登录路由器 — 密码全程不经过 LLM。**

[English](README.md) | 中文

Cerberus KeyRouter 是一个 MCP（Model Context Protocol）服务器，让 AI Agent 安全地登录网站。密码存储在 Vaultwarden（自托管 Bitwarden）中，Agent 只使用 `{{placeholder}}` 占位符 — 真实凭据通过 Chrome DevTools Protocol (CDP) 在本地注入，永远不会进入 LLM 上下文。

## 解决什么问题

当 AI Agent 自动化浏览器操作时，通常需要在上下文窗口中获取登录凭据。这意味着你的密码会：

- 发送到云端 LLM 提供商（OpenAI、Anthropic 等）
- 存储在对话日志中
- 可能通过 prompt injection 攻击泄露

Cerberus KeyRouter 将凭据保留在本地密码库中，在浏览器层面注入 — LLM 只看到 `{{email}}` 和 `{{password}}` 占位符。

## 架构

```
┌─ 你的本地机器 ──────────────────────────────────┐
│                                                  │
│  AI Agent (OpenClaw 等)                          │
│    │                                             │
│    │ MCP 调用: secure_login("GitHub",            │
│    │   steps: [                                  │
│    │     {fill, "#email", "{{email}}"},           │
│    │     {fill, "#password", "{{password}}"},     │
│    │     {click, "#submit"}                      │
│    │   ])                                        │
│    │  + Authorization: Bearer <account-token>     │
│    │                                             │
│    ▼                                             │
│  Login Router (localhost:8899)                   │
│    ├─ Bearer Token 路由 → 对应账户               │
│    ├─ 从 Vaultwarden 获取凭据                    │
│    ├─ 替换 {{占位符}} 为真实值                    │
│    ├─ 通过 Chrome CDP 执行                       │
│    ├─ 清除内存中的凭据                           │
│    └─ 返回 { status: "ok" }（不含密码）          │
│                                                  │
│  Admin 面板 (localhost:8899/admin)               │
│    └─ 管理账户、设置、Bearer Token               │
│                                                  │
│  Vaultwarden (Docker, localhost:8443)            │
│    └─ E2E 加密密码存储                           │
│                                                  │
│  Chrome (CDP 端口 localhost:18800)               │
│    └─ 接收 fill/click/type 命令                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

- LLM 永远看不到明文密码
- 凭据仅在 Login Router 内存中短暂存在
- 所有通信仅限本地
- 支持多个 Vaultwarden 账户，各自隔离

## 功能特性

- **LLM 零知识** — 密码永远不进入 AI 上下文
- **Vaultwarden 集成** — 自托管、E2E 加密的密码存储
- **多账户支持** — 管理多个 Vaultwarden 账户，每个账户有独立的 Bearer Token
- **Admin 面板** — `/admin` Web UI 管理账户，Session-based 认证 + 密码保护
- **自动获取 API Key** — 只需提供邮箱 + 主密码，API Key 自动获取
- **MCP 协议** — 兼容任何支持 MCP 的 AI Agent
- **占位符模式** — `{{email}}`、`{{password}}`、`{{totp}}`
- **fill & type** — `fill` 适用于标准表单，`type`（逐字符输入）适用于 React/SPA 站点
- **智能 Tab 匹配** — 通过 URL 域名和 CSS selector 检测找到正确的浏览器 Tab
- **两级保护模式** — Standard（自动解锁）或 Advanced（手动解锁 + Telegram 审批）
- **Telegram 集成** — 解锁通知、含确认码的审批请求、登录执行结果推送
- **移动端审批页面** — `/approve` 页面随时随地解锁密码库和审批登录请求
- **安全加固** — 限流、URL 验证、审计日志、Bearer Token 认证
- **审计日志** — `/audit` Web UI 查看所有登录记录（不记录密码）

## 快速开始

### 前置条件

- Docker & Docker Compose
- 启用远程调试的 Chrome/Chromium（`--remote-debugging-port=18800`）
- 支持 MCP 的 AI Agent（如 [OpenClaw](https://github.com/openclaw/openclaw)）

### 1. 克隆 & 配置

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
```

编辑 `.env` — 只需要设置一个变量：

```bash
VW_ADMIN_TOKEN=your-secret-token-here
```

此 Token 用于首次 Admin 登录和密码重置。

### 2. 启动服务

```bash
docker compose up --build -d
```

启动后包含：
- **Vaultwarden** — `https://localhost:8443`（密码库）
- **Login Router** — `http://localhost:8899`（MCP 服务器 + Admin 面板）

验证：`curl http://localhost:8899/health` 应返回 `{"status":"ok"}`

### 3. 创建 Vaultwarden 账户

在浏览器中打开 `https://localhost:8443`（接受自签名证书）。

1. 点击 **创建账户**
2. 设置邮箱和主密码
3. 登录后为你的网站添加登录项（名称、用户名、密码、URI）

### 4. 设置 Admin 面板

打开 `http://localhost:8899/admin`：

1. **首次登录** — 输入 `.env` 中的 `VW_ADMIN_TOKEN`
2. **设置管理密码** — 系统会提示你创建个人密码（至少 8 位）。设置后 `VW_ADMIN_TOKEN` 将不能再用于 Admin 登录
3. 之后使用新密码登录

> **忘记密码？** 在登录页面点击"忘记密码？"链接，输入 `VW_ADMIN_TOKEN` 即可重置。

### 5. 添加 Vaultwarden 账户

在 Admin 面板中：

1. （可选）更新 **Vaultwarden URL**（如使用自定义域名）
2. 点击 **+ Add Account**
3. 输入 Vaultwarden **邮箱** 和 **主密码**
4. 系统自动完成：
   - 连接 Vaultwarden 获取 API Key
   - 启动专属 `bw serve` 进程
   - 生成唯一的 **Bearer Token**
5. 复制 Bearer Token（点击 Token 单元格，或点 **MCP** 按钮复制完整 MCP 配置）

### 6. 连接 AI Agent

添加到你的 MCP 配置：

```json
{
  "mcpServers": {
    "cerberus": {
      "url": "http://localhost:8899/mcp",
      "headers": {
        "Authorization": "Bearer <你的-bearer-token>"
      }
    }
  }
}
```

### 7. 测试

```bash
# 健康检查
curl http://localhost:8899/health

# 列出可用登录项（不显示密码）
curl http://localhost:8899/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Admin 面板

访问 `http://localhost:8899/admin`。

**认证：**
- 首次登录使用 `VW_ADMIN_TOKEN`，之后设置个人密码（PBKDF2-SHA256 哈希）
- Session 有效期 8 小时
- 可随时在设置中修改密码
- 忘记密码？在登录页面用 `VW_ADMIN_TOKEN` 重置

**功能：**
- **设置** — 配置默认 Vaultwarden URL、Telegram 通知
- **账户管理** — 添加、测试、重启、禁用或删除 Vaultwarden 账户
- **Bearer Token** — 每个账户生成唯一 Token，点击即可复制
- **MCP 配置** — 一键复制可直接使用的 MCP JSON 配置
- **保护模式** — Standard（自动解锁）或 Advanced（手动解锁 + Telegram 审批）
- **Unlock / Lock** — 直接在账户列表中解锁或锁定 Advanced 模式账户
- **bw serve 状态** — 查看各账户运行状态

**其他页面：**
- `/approve` — 移动端友好的审批页面，用于解锁 Advanced 模式账户和审批登录请求
- `/audit` — 可搜索的审计日志

## 保护模式

每个 Vaultwarden 账户可以配置两种保护级别：

### Standard 模式（默认）

- 服务启动时 **自动解锁** 密码库
- 登录请求立即执行
- 适合低风险账户或开发使用

### Advanced 模式

- 密码库保持 **锁定** 状态，需通过 `/approve` 页面或 Admin 面板手动解锁
- 每次 `secure_login` 调用都需要 **实时审批**，附带 4 位确认码
- 审批须在 **50 秒** 内完成，超时自动拒绝
- 适合敏感账户（银行、金融服务等）

### Telegram 通知

在设置中配置 Telegram（Bot Token + Chat ID）后，Advanced 模式账户会收到：

1. **解锁通知** — 密码库解锁成功时推送
2. **审批请求** — Agent 调用 `secure_login` 时推送，包含站点名称和 4 位确认码
3. **执行结果** — 登录成功或失败后推送

这形成了一个人在回路（human-in-the-loop）的流程：AI Agent 发起登录请求 → 你在手机上收到通知 → 在 `/approve` 页面输入确认码 → 登录执行。

## MCP 工具

### `list_vault_items`

返回可用的登录项 — 仅包含站点名称和用户名，**不含密码**。

### `secure_login`

执行带占位符替换的登录序列。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `vaultItem` | string | 要使用的密码库条目名称 |
| `steps` | array | 有序的浏览器操作列表 |

**操作类型：**

| 操作 | 说明 | 使用场景 |
|------|------|---------|
| `fill` | 设值 + 触发 input/change 事件 | 标准表单，大多数网站 |
| `type` | 逐字符输入（50ms 间隔） | React 受控组件、SPA |
| `click` | 点击元素 | 提交按钮 |
| `wait` | 等待导航或 selector | 页面跳转、多步登录 |
| `select` | 选择下拉选项 | Select 元素 |

**占位符：** `{{email}}`、`{{username}}`、`{{password}}`、`{{totp}}`

## 多步登录 (SPA)

有些网站分多步登录。通过拆分为多次调用来处理：

```json
// 第 1 步：输入用户名，进入密码页面
{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#username", "value": "{{username}}"},
    {"action": "click", "selector": "#next-btn"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}

// 第 2 步：输入密码，提交
{
  "vaultItem": "MyBank",
  "steps": [
    {"action": "type", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#login-btn"},
    {"action": "wait", "navigation": true}
  ]
}
```

## 安全

### 设计原则

- **密码不经过 LLM** — AI 上下文中只有 `{{placeholder}}` 占位符
- **用后即清** — 注入后立即从内存清除凭据
- **仅限本地** — MCP 服务器在 Docker 内绑定 `0.0.0.0:8899`，仅在 localhost 暴露
- **Vaultwarden E2E 加密** — 数据静态加密，没有主密码无法读取
- **AES-256-GCM 加密** — 存储的主密码使用自动生成的密钥加密（独立于 Admin Token）
- **PBKDF2-SHA256 管理密码** — Admin 面板密码使用 310k 次迭代哈希，不存储明文
- **Session-based 认证** — Admin API 使用服务端 Session（8 小时 TTL），而非裸 Token
- **指令序列，非脚本** — 仅支持预定义操作（fill/type/click/wait/select），不执行任意 JS
- **占位符注入防护** — `{{password}}` 仅允许在 fill/type 的 value 字段中使用，在 selector 中使用会被拒绝

### 威胁模型

| 威胁 | 缓解措施 |
|------|---------|
| Prompt injection 引导登录钓鱼站点 | Vaultwarden 作为隐式白名单；通过 CDP 验证 URL |
| 未授权 MCP 访问 | 每个账户独立的 Bearer Token 认证 |
| 凭据滥用 / 重复尝试 | 限流（3 次/分钟，20 次/小时）+ 失败后冷却 |
| 敏感账户未授权登录 | Advanced 模式：手动解锁 + 确认码审批（50s 超时） |
| URL 伪造 | Login Router 通过 CDP 读取浏览器实际 URL，与密码库 URI 比对 |
| 缺少审计追踪 | 结构化审计日志（`/audit`），不记录密码 |
| 存储密码泄露 | 主密码使用 AES-256-GCM 加密（自动生成密钥） |
| Admin 面板暴力破解 | PBKDF2-SHA256 哈希密码 + Session-based 认证 |
| 凭据使用无感知 | Telegram 通知：解锁、审批请求、执行结果 |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `VW_ADMIN_TOKEN` | 是 | 首次 Admin 登录 Token 和密码重置凭证 |

其他所有配置（Vaultwarden URL、账户、Bearer Token、Telegram、限流）通过 Admin 面板管理，或在 `docker-compose.yml` 中有合理的默认值。

## 路线图

- [ ] Cookie 缓存（登录一次，复用会话）
- [ ] 支持 OpenClaw snapshot ref ID（CSS selector 之外的另一种选择）
- [ ] 多 Agent 框架支持

## 许可证

本项目采用 **GNU Affero General Public License v3.0 (AGPL-3.0)** 许可。详见 [LICENSE](LICENSE)。

- 个人使用、测试和自托管免费
- 可在同一许可下自由修改和分发
- 如果将修改版本作为网络服务运行，必须公开源代码
- 商业许可请联系作者

## 致谢

- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — 自托管 Bitwarden 服务器
- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 框架
- [Playwright](https://playwright.dev/) — 浏览器自动化
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol
