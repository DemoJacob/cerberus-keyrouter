# Cerberus KeyRouter - 安全登录架构设计

> 创建时间：2026-02-14
> 状态：开源原型开发阶段
> 最后更新：2026-02-14 23:30

## 问题

OpenClaw 在执行浏览器自动化时，如果需要登录网站，密码明文会进入 LLM 上下文（发送给 Claude/OpenAI API）。需要一套方案让 LLM 永远接触不到密码明文。

## 核心思路

**LLM 写逻辑（用占位符） → 登录路由替换明文 → CDP 执行操作**

LLM 能看到页面结构、灵活处理各种登录流程，但只使用 `{{email}}`、`{{password}}`、`{{totp}}` 等占位符，真实密码由登录路由在本地替换后直接通过 CDP 注入浏览器。

---

## 阶段规划

### 阶段 1：开源原型（当前）
- Vaultwarden + 登录路由，Docker 部署
- MIT 许可，社区验证效果
- 目标：验证可行性，收集反馈

### 阶段 2：商用 SaaS
- 自研密码管理后端（替代 Vaultwarden，避免 AGPL）
- E2E 加密，多租户，类 1Password 架构
- 客户端（Docker 镜像/npm 包）部署在用户的 OpenClaw 环境
- 客户端职责：从 SaaS 拉取密文 → 本地解密 → CDP 注入浏览器
- SaaS 永远不接触明文密码

---

## 当前开发架构（阶段 1 - Mac 本地环境）

### 部署拓扑

```
┌─ Mac 宿主机 ──────────────────────────────┐
│                                            │
│  OpenClaw Gateway                          │
│  Chrome (openclaw profile, CDP:18800)      │
│  mcporter → localhost:8899 (MCP)           │
│                                            │
└──────────┬─────────────────────────────────┘
           │ localhost:8899 (MCP 调用)
           │ host.docker.internal:18800 (CDP 反向访问)
┌─ Docker Desktop ─┴─────────────────────────┐
│                                             │
│  ┌─ login-router (:8899) ─────────────────┐ │
│  │  MCP Server (Streamable HTTP)          │ │
│  │  接收 LLM 指令序列（含占位符）          │ │
│  │  调用 Vaultwarden 取密码               │ │
│  │  替换占位符                            │ │
│  │  通过 CDP 操作宿主机浏览器              │ │
│  │  返回结果（不含密码）                  │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ vaultwarden (:8080→80) ───────────────┐ │
│  │  密码存储（AGPLv3，免费使用）           │ │
│  │  E2E 加密，~50MB 内存                  │ │
│  │  Bitwarden CLI (bw) 访问              │ │
│  │  Web UI: http://localhost:8080          │ │
│  └────────────────────────────────────────┘ │
│                                             │
└─────────────────────────────────────────────┘
```

### 关键网络路径

| 方向 | 路径 | 说明 |
|------|------|------|
| OpenClaw → MCP | `localhost:8899` | Docker 端口映射到宿主机 |
| login-router → Vaultwarden | `http://vaultwarden:80` | Docker 内网，不出容器 |
| login-router → Chrome CDP | `http://host.docker.internal:18800` | Mac Docker Desktop 原生支持 |
| 用户 → Vaultwarden Web UI | `http://localhost:8080` | 管理密码用 |

### 已验证

- ✅ Mac 宿主机 Chrome CDP 端口 18800 正常运行（Chrome/144.0.7559.133）
- ✅ Mac Docker Desktop 原生支持 `host.docker.internal`，无需额外配置
- ✅ OpenClaw 浏览器使用 CDP + Playwright 双层架构

---

## 技术细节

### OpenClaw 浏览器工作原理

```
Agent 循环：snapshot → LLM 分析页面 → act 操作 → snapshot → 循环

底层技术栈：
  OpenClaw Gateway
      ↓ HTTP (loopback)
  本地控制服务
      ↓ CDP (Chrome DevTools Protocol)
  Chromium 浏览器（独立 profile, 端口 18800）
      ↑ Playwright（高级操作层：点击、输入、快照）
```

- 页面快照使用语义 ref ID（基于 accessibility tree），非 CSS 选择器，更稳定
- 两种 ref 格式：数字 ref（AI snapshot）和 `e12` 格式（role snapshot）
- 每次操作后必须重新 snapshot，LLM 才知道当前页面状态

### MCP 接口设计

**工具 1：`secure_login`**

LLM 先通过 `browser.snapshot()` 看到登录页面结构，然后生成指令序列：

```json
{
  "tool": "secure_login",
  "params": {
    "vaultItem": "GitHub",
    "steps": [
      { "action": "fill", "selector": "#login_field", "value": "{{email}}" },
      { "action": "fill", "selector": "#password", "value": "{{password}}" },
      { "action": "click", "selector": "[name='commit']" },
      { "action": "wait", "navigation": true },
      { "action": "fill", "selector": "#otp", "value": "{{totp}}" }
    ]
  }
}
```

**支持的动作类型：**

| action | 说明 | 参数 |
|--------|------|------|
| `fill` | 填入内容（支持占位符替换） | `selector`, `value` |
| `click` | 点击元素 | `selector` |
| `wait` | 等待 | `navigation: true` 或 `selector`（等元素出现） |
| `select` | 下拉选择 | `selector`, `value` |

**工具 2：`check_login_status`（可选）**

```json
{
  "tool": "check_login_status",
  "params": { "vaultItem": "GitHub" }
}
// 返回：{ "loggedIn": true, "lastLogin": "2026-02-14T22:00:00Z" }
```

**工具 3：`list_vault_items`（可选）**

```json
{
  "tool": "list_vault_items",
  "params": {}
}
// 返回站点列表（不含密码）：[{ "name": "GitHub", "username": "jacob@..." }, ...]
```

### 占位符变量

| 变量 | Vaultwarden CLI 命令 | 说明 |
|------|---------------------|------|
| `{{email}}` / `{{username}}` | `bw get username "<item>"` | 登录用户名/邮箱 |
| `{{password}}` | `bw get password "<item>"` | 登录密码 |
| `{{totp}}` | `bw get totp "<item>"` | 两步验证码（实时生成） |

### 安全设计要点

1. **指令序列，非任意脚本**：只执行预定义动作类型（fill/click/wait/select），不执行任意 JS，防止 LLM 注入恶意代码窃取密码
2. **占位符只在 `fill` 的 `value` 字段替换**：其他字段出现 `{{password}}` 直接拒绝
3. **密码用完立即清零**：`credentials = null`
4. **返回值不含密码**：只返回 `{ status: "ok" }` 或错误信息
5. **Vaultwarden 不暴露公网**：仅 Docker 内网 + localhost:8080

### 潜在安全风险及防护

| 风险 | 场景 | 防护 |
|------|------|------|
| LLM 注入 | LLM 在 selector 中嵌入 JS | 只允许 CSS 选择器，禁止 `javascript:` |
| 密码泄露到日志 | 替换后的脚本被 console.log | 登录路由不输出包含密码的日志 |
| CDP 端口暴露 | 外部访问宿主机 18800 | CDP 绑定 127.0.0.1，防火墙限制 |
| Vaultwarden 被攻破 | 服务器数据库被盗 | E2E 加密，没有主密码解不开 |

---

## Docker Compose（开发用）

```yaml
version: '3'
services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: always
    volumes:
      - ./vw-data:/data
    environment:
      - SIGNUPS_ALLOWED=false
      - ADMIN_TOKEN=${VW_ADMIN_TOKEN}
      - DOMAIN=http://localhost:8080
    ports:
      - "8080:80"
    networks:
      - secure-net

  login-router:
    build: ./login-router
    restart: always
    environment:
      - BW_URL=http://vaultwarden:80          # Docker 内网访问 Vaultwarden
      - BW_CLIENTID=${BW_CLIENTID}            # Bitwarden API Key (client_id)
      - BW_CLIENTSECRET=${BW_CLIENTSECRET}    # Bitwarden API Key (client_secret)
      - CDP_URL=http://host.docker.internal:18800  # 宿主机 Chrome CDP
      - MCP_PORT=8899
    ports:
      - "8899:8899"    # MCP Server 端口，OpenClaw mcporter 调用
    depends_on:
      - vaultwarden
    networks:
      - secure-net

networks:
  secure-net:
    driver: bridge
```

> **注意**：Mac Docker Desktop 不需要 `extra_hosts`，`host.docker.internal` 开箱即用。Linux 需要加 `extra_hosts: ["host.docker.internal:host-gateway"]`。

### .env 文件

```bash
VW_ADMIN_TOKEN=你的管理员密码（用于 Vaultwarden /admin 面板）
BW_CLIENTID=user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BW_CLIENTSECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 登录路由开发规格

### 技术栈

- **运行时**：Node.js（与 OpenClaw 生态一致）
- **MCP 协议**：Streamable HTTP（与现有 mcporter 兼容）
- **浏览器操作**：Playwright（通过 CDP 连接宿主机 Chrome）
- **Vaultwarden 交互**：Bitwarden CLI (`bw`) 或直接调 Bitwarden API

### 目录结构

```
login-router/
├── Dockerfile
├── package.json
├── src/
│   ├── index.js              # MCP Server 入口
│   ├── mcp-handler.js        # MCP 工具注册和处理
│   ├── credential-manager.js # Vaultwarden 交互（取密码）
│   ├── browser-executor.js   # CDP + Playwright 执行登录步骤
│   ├── placeholder.js        # 占位符替换逻辑
│   └── security.js           # 输入校验、注入防护
├── docker-compose.yml
├── .env.example
└── README.md
```

### 核心流程（伪代码）

```javascript
// mcp-handler.js
async function handleSecureLogin({ vaultItem, steps }) {
  // 1. 输入校验
  validateSteps(steps);  // 检查注入风险

  // 2. 从 Vaultwarden 取凭据
  const creds = await credentialManager.get(vaultItem);
  // creds = { username: "xxx", password: "xxx", totp: "123456" }

  // 3. 替换占位符（只在 fill.value 中替换）
  const resolvedSteps = replacePlaceholders(steps, creds);

  // 4. CDP 连接浏览器，执行步骤
  const result = await browserExecutor.execute(resolvedSteps);

  // 5. 清除敏感数据
  secureClear(creds);
  secureClear(resolvedSteps);

  // 6. 返回结果（不含密码）
  return { status: result.success ? "ok" : "error", message: result.message };
}
```

### Bitwarden CLI 认证方式

```bash
# API Key 认证（无人值守，适合 Docker）
export BW_CLIENTID="user.xxx"
export BW_CLIENTSECRET="xxx"
bw login --apikey

# 解锁 vault（需要主密码，启动时一次性输入）
export BW_SESSION=$(bw unlock --raw --passwordenv BW_MASTER_PASSWORD)

# 取密码
bw get password "GitHub"
bw get username "GitHub"
bw get totp "GitHub"
```

> **注意**：Docker 启动时需要提供 `BW_MASTER_PASSWORD` 环境变量来解锁 vault。此密码仅在容器内存中存在，不写日志、不传给 LLM。

### Playwright CDP 连接

```javascript
// browser-executor.js
const { chromium } = require('playwright');

async function execute(steps) {
  // 连接宿主机 Chrome（不启动新实例）
  const browser = await chromium.connectOverCDP(process.env.CDP_URL);
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0]; // 当前活跃页面

  for (const step of steps) {
    switch (step.action) {
      case 'fill':
        await page.fill(step.selector, step.value);
        break;
      case 'click':
        await page.click(step.selector);
        break;
      case 'wait':
        if (step.navigation) await page.waitForNavigation();
        if (step.selector) await page.waitForSelector(step.selector);
        break;
      case 'select':
        await page.selectOption(step.selector, step.value);
        break;
    }
  }

  return { success: true };
}
```

---

## 数据流（完整安全链路）

```
┌─ LLM 视角 ─────────────────────────────────────────┐
│                                                      │
│  1. browser.snapshot()                               │
│     → 看到: textbox "Email" [ref=e10]                │
│             textbox "Password" [ref=e12]             │
│             button "Sign in" [ref=e15]               │
│                                                      │
│  2. LLM 决策：需要登录，调用 secure_login             │
│     → 生成指令序列（占位符，不含密码）                 │
│                                                      │
│  3. 调用 MCP tool: secure_login({                    │
│       vaultItem: "GitHub",                           │
│       steps: [                                       │
│         { fill, "#email", "{{email}}" },              │
│         { fill, "#password", "{{password}}" },        │
│         { click, "[type=submit]" },                   │
│         { wait, navigation: true }                    │
│       ]                                              │
│     })                                               │
│                                                      │
│  4. 收到返回：{ status: "ok" }                        │
│                                                      │
│  5. browser.snapshot()                               │
│     → 看到已登录的页面                                │
│                                                      │
│  ✅ LLM 全程不知道真实密码                             │
└──────────────────────────────────────────────────────┘

┌─ 登录路由内部（Docker 容器内） ─────────────────────┐
│                                                      │
│  1. 收到指令序列（含 {{password}} 占位符）            │
│  2. 校验指令合法性（防注入）                          │
│  3. bw get username/password/totp "GitHub"            │
│     → Vaultwarden 返回明文（Docker 内网）             │
│  4. 替换：{{email}} → "jacob@xxx.com"                │
│           {{password}} → "实际密码"                   │
│  5. Playwright connectOverCDP → 宿主机 Chrome         │
│  6. page.fill("#email", "jacob@xxx.com")              │
│     page.fill("#password", "实际密码")                │
│     page.click("[type=submit]")                       │
│  7. 密码变量清零                                     │
│  8. 返回 { status: "ok" }                            │
│                                                      │
│  ✅ 密码只在容器内存中短暂存在                        │
└──────────────────────────────────────────────────────┘
```

---

## SaaS 架构（阶段 2 规划）

### 与阶段 1 的区别

| | 阶段 1（开源） | 阶段 2（SaaS） |
|--|--------------|---------------|
| 密码存储 | Vaultwarden (AGPLv3) | 自研 E2E 加密服务 |
| 部署 | 用户全部自建 | SaaS 后端 + 用户本地客户端 |
| 密码管理 | Vaultwarden Web UI | 自研 Web UI + App |
| 收费 | 免费 | 按用量/订阅 |

### SaaS 拓扑

```
┌─ 你的云 (SaaS) ──────────────────────────┐
│  自研密码管理服务（E2E 加密）              │
│  用户管理 / 团队 / 计费 / 审计             │
│  API 网关                                 │
│                                           │
│  ⚠️ 服务端永远不知道用户密码明文            │
│  （和 1Password 一样的零知识架构）          │
└──────────────┬────────────────────────────┘
               │ HTTPS (只传密文)
┌─ 客户环境 ───┴────────────────────────────┐
│                                            │
│  客户端 (Docker sidecar / npm 包 / 二进制)  │
│  ├─ 从 SaaS 拉取密文                      │
│  ├─ 用户主密码本地解密                     │
│  ├─ CDP 注入浏览器（localhost）             │
│  └─ MCP Server（OpenClaw 直接调用）        │
│                                            │
│  OpenClaw + Chrome                         │
│  （必须在同一机器/Docker 网络）             │
└────────────────────────────────────────────┘
```

### 客户端必须与浏览器同环境的原因

```
密码明文 → page.fill() → CDP 协议 → Chrome

CDP 绑定 localhost:18800
客户端必须能访问 localhost (或 Docker 内网) 的 CDP 端口
远程访问 CDP = 暴露浏览器控制权 = 重大安全隐患

因此客户端部署方式：
  ① Docker sidecar（和 OpenClaw 同一 compose）
  ② 安装在宿主机上（和 OpenClaw 同一台机器）
  ③ OpenClaw Skill（npm install）
```

### 商业模式

```
免费开源版：
  - Vaultwarden + 登录路由（自建）
  - MIT 许可
  - 5 个站点配置上限（软限制）

SaaS 付费版：
  - 托管密码管理（零知识 E2E 加密）
  - Web/App 密码管理界面
  - 无限站点
  - Cookie 缓存 + 自动续期
  - 审计日志
  - 团队协作

定价（规划）：
  - Starter: $9/月 (50 次登录/月)
  - Pro: $29/月 (500 次登录/月)
  - Enterprise: 定制
```

---

## 许可证策略

| 组件 | 许可证 | 说明 |
|------|--------|------|
| Vaultwarden | AGPLv3 | 免费使用，不修改不分发，合规 |
| 登录路由（开源版） | MIT | 自由使用、修改、商用 |
| 登录路由（SaaS 版） | 商业许可 | 闭源 |
| SaaS 密码管理后端 | 商业许可 | 自研，替代 Vaultwarden |
| 客户端 | 免费（可能开源） | 鼓励用户使用 |

**AGPL 合规关键：** 登录路由通过 HTTP API / CLI 调用 Vaultwarden，不构成衍生作品。Docker Compose 中 Vaultwarden 是用户自行拉取的独立服务。

---

## 开发清单

### MVP（最小可用版本）

- [ ] Docker Compose: Vaultwarden + login-router
- [ ] login-router: MCP Server 框架 (Streamable HTTP, :8899)
- [ ] login-router: `secure_login` 工具实现
  - [ ] 指令序列解析 + 校验
  - [ ] Bitwarden CLI 集成 (bw get)
  - [ ] 占位符替换
  - [ ] Playwright CDP 连接 + 执行
  - [ ] 安全清理
- [ ] login-router: `list_vault_items` 工具（列出可用站点）
- [ ] OpenClaw mcporter 配置
- [ ] 端到端测试：LLM → MCP → 登录 → 成功
- [ ] README + 部署文档

### 后续优化

- [ ] Cookie 缓存（登录一次，后续直接注入 cookie）
- [ ] 错误处理（登录失败重试、验证码识别）
- [ ] 多浏览器 tab 支持（targetId 参数）
- [ ] 支持 ref ID 替代 CSS selector（兼容 OpenClaw snapshot）
- [ ] 审计日志（谁在什么时候用了哪个密码登录了哪个站点）
- [ ] Web UI 配置界面

### SaaS 阶段

- [ ] 自研 E2E 加密密码管理后端
- [ ] 用户注册 / 认证 / 计费
- [ ] 客户端 Docker 镜像发布
- [ ] 多 AI Agent 框架支持（不只 OpenClaw）

---

## 安全机制设计（2026-02-15 更新）

> **核心洞察**：Vaultwarden 本身就是天然白名单——只有存了密码的站点才能通过 login-router 登录，不需要维护额外的域名白名单。

### 架构调整：login-router 改为本机运行

```
┌─ Mac 宿主机 ─────────────────────────────────┐
│                                               │
│  OpenClaw Gateway                             │
│  Chrome (openclaw profile, CDP:18800)         │
│                                               │
│  login-router (本机 Node.js, :8899)           │
│  ├─ MCP Server (Streamable HTTP)              │
│  ├─ 连 Vaultwarden: localhost:8080            │
│  └─ 连 Chrome CDP: 127.0.0.1:18800           │
│                                               │
│  ┌─ Docker ────────────────────────┐          │
│  │  Vaultwarden (:8080→80)        │          │
│  │  密码存储（E2E 加密）           │          │
│  └─────────────────────────────────┘          │
└───────────────────────────────────────────────┘
```

**好处**：
- 不需要 `--remote-allow-origins=*`（本机访问 127.0.0.1，Chrome 默认接受）
- 不需要改 OpenClaw 浏览器配置
- 少一层 Docker 网络复杂度
- Vaultwarden 仍在 Docker 中隔离运行

### 威胁模型

| 威胁 | 风险 | 说明 |
|------|------|------|
| **Prompt injection** | 🔴 高 | 恶意网页诱导 LLM 调用 `secure_login` 登录钓鱼站 |
| **MCP 未授权访问** | 🟡 中 | 本机其他进程/恶意软件连 8899 端口直接调用 |
| **凭据滥用** | 🟡 中 | LLM 被诱导对同一站点反复尝试登录 |
| **URL 欺骗** | 🔴 高 | LLM 说"登录 google.com"，但浏览器实际在 `g00gle.com` |
| **审计缺失** | 🟡 中 | 出事后无法追溯操作历史 |

### 五层防御

#### 1. 真实 URL 校验（Anti-Phishing）

login-router 在注入凭据前，通过 CDP 读取浏览器**地址栏的真实 URL**，与 Vaultwarden 中该条目保存的 URI 进行匹配。

```
LLM 请求：secure_login("GitHub")
Vaultwarden 条目 URI：https://github.com/login
浏览器实际 URL：https://github.com/login ✅ 匹配，继续
浏览器实际 URL：https://g1thub.com/login ❌ 不匹配，拒绝
```

- 支持子域名匹配：`accounts.google.com` → 匹配 Vault 中的 `google.com` ✅
- **不匹配 → 立即拒绝，返回错误，不注入任何凭据**
- 防止 prompt injection 引导 LLM 在钓鱼页面上触发登录

#### 2. 人工确认（Human-in-the-Loop，分级）

```json
{
  "confirmationPolicy": {
    "always": ["bank.com", "paypal.com"],
    "firstTime": ["github.com", "aws.com"],
    "auto": ["google.com"]
  }
}
```

| 级别 | 行为 | 适用场景 |
|------|------|----------|
| `always` | 每次登录都通过 Telegram 发确认请求 | 银行、支付等高敏感站点 |
| `firstTime` | 首次需确认，确认后自动（可设过期） | 一般重要站点 |
| `auto` | 无需确认，自动执行 | 日常低风险站点 |

- 确认超时（60s）→ 自动拒绝
- 确认通过 Telegram inline button 实现（✅ 允许 / ❌ 拒绝）

#### 3. MCP 端点认证

- login-router 启动时生成随机 **Bearer Token**，写入本地文件（如 `~/.cerberus/mcp-token`）
- OpenClaw mcporter 配置中携带该 token
- 无 token 或 token 不匹配 → 403 Forbidden
- 端口绑定 `127.0.0.1:8899`（仅本机可达，外部不可访问）

#### 4. 速率限制 + 冷却

```json
{
  "rateLimit": {
    "maxLoginsPerMinute": 3,
    "maxLoginsPerHour": 20,
    "cooldownAfterFailure": 30
  }
}
```

- 防止 LLM 被 prompt injection 诱导反复尝试
- 连续失败后自动冷却 30 秒
- 超过小时限制 → 需人工解锁

#### 5. 完整审计日志

每次 `secure_login` 调用记录：

```json
{
  "timestamp": "2026-02-15T00:55:00Z",
  "action": "secure_login",
  "vaultItem": "GitHub",
  "actualUrl": "https://github.com/login",
  "urlMatch": true,
  "username": "j***@gmail.com",
  "result": "success",
  "confirmationType": "auto",
  "durationMs": 3200
}
```

- 用户名脱敏显示（只露前缀）
- **密码永远不记录**
- 日志存本地文件（`~/.cerberus/audit.log`）
- 可选：异常事件（URL 不匹配、频率超限）实时 Telegram 告警

### 凭据最小暴露原则

- LLM 只传 `vaultItem`（站点名称），**不传用户名/密码**
- login-router 自行从 Vaultwarden 查找匹配凭据
- LLM 永远不知道密码库里有哪些条目（除非主动调用 `list_vault_items`，该接口也只返回站点名 + 脱敏用户名）
- 返回值只有 `{ status: "ok", username: "j***@gmail.com" }`

### 完整安全链路

```
LLM 请求 secure_login("GitHub")
  │
  ├─ ① Vault 中有该条目？ ──否──→ ❌ 拒绝（天然白名单）
  │
  ├─ ② MCP Bearer Token 正确？ ──否──→ ❌ 403
  │
  ├─ ③ 速率限制通过？ ──否──→ ❌ 限流，等待冷却
  │
  ├─ ④ 需要人工确认？ ──是──→ Telegram 确认
  │                    ──超时─→ ❌ 拒绝
  │
  ├─ ⑤ CDP 读真实 URL，与 Vault URI 匹配？ ──否──→ ❌ 拒绝（疑似钓鱼）
  │
  ├─ ⑥ 从 Vaultwarden 取凭据 → 替换占位符
  │
  ├─ ⑦ CDP 执行操作 → 密码变量清零
  │
  └─ ⑧ 记录审计日志 → 返回脱敏结果
```

**五层防御，LLM 从头到尾看不到任何明文密码。**
