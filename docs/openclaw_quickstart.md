# Cerberus KeyRouter × OpenClaw — Quick Start

> 5 分钟让你的 AI Agent 安全登录任何网站，密码全程不经过 LLM。

## 你需要什么

| 组件 | 说明 |
|------|------|
| [OpenClaw](https://github.com/openclaw/openclaw) | AI Agent 框架，提供浏览器自动化 |
| Docker Desktop | 运行 Vaultwarden 和 Login Router |
| [mcporter](https://mcporter.dev) | OpenClaw 推荐的 MCP 客户端，用于连接外部 MCP Server（`npm i -g mcporter`） |

## 第 1 步：启动 Cerberus

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
# 编辑 .env，设置一个 VW_ADMIN_TOKEN（任意强密码即可）
docker compose up --build -d
```

等待约 30 秒，验证服务正常：

```bash
curl http://localhost:8899/health
# → {"status":"ok"}
```

启动后你会得到：
- **Vaultwarden** — `https://localhost:8443`（密码保险库）
- **Login Router** — `http://localhost:8899`（MCP Server + Admin 面板）

## 第 2 步：初始化 Admin 面板

打开 `http://localhost:8899/admin`：

1. 用 `.env` 里的 `VW_ADMIN_TOKEN` 首次登录
2. 系统会要求你设置一个个人密码（之后用这个密码登录）
3. 登录后进入管理界面

## 第 3 步：创建 Vaultwarden 账户 & 添加密码

打开 `https://localhost:8443`（接受自签名证书）：

1. **注册账户** — 填写邮箱和主密码
2. **添加登录项** — 每个网站一条记录：
   - **名称**：简短标识（如 `GitHub`、`MyBank`）
   - **用户名**：登录邮箱或用户名
   - **密码**：网站密码
   - **URI**：登录页地址（如 `https://example.com/login`）

## 第 4 步：在 Admin 面板关联账户

回到 `http://localhost:8899/admin`：

1. 点击 **+ Add Account**
2. 输入你的 Vaultwarden **邮箱** 和 **主密码**
3. 系统自动获取 API Key、启动 `bw serve`、生成 **Bearer Token**
4. 复制 Bearer Token（点击 token 单元格，或点 **MCP** 按钮复制完整配置）

## 第 5 步：连接 OpenClaw

### 5a. 启动浏览器

在 OpenClaw 对话中让 Agent 启动浏览器：

```
请启动浏览器
```

OpenClaw 会使用自己的 browser profile 启动 Chrome（CDP 端口 18800），Login Router 通过这个端口注入凭据。

### 5b. 配置 MCP 连接

**方式一：直接在聊天中告诉 Agent**

在 OpenClaw 对话中发送：

```
请添加 MCP 配置：
- 名称：cerberus
- URL：http://localhost:8899/mcp
- Bearer Token：<你的-bearer-token>
```

Agent 会自动将配置写入 mcporter 配置文件。

**方式二：手动编辑配置文件**

编辑 `~/.openclaw/workspace/config/mcporter.json`：

```json
{
  "mcpServers": {
    "cerberus": {
      "baseUrl": "http://localhost:8899/mcp",
      "headers": {
        "Authorization": "Bearer <你的-bearer-token>"
      }
    }
  }
}
```

验证连接：
```bash
npx mcporter list cerberus
# 应该看到 secure_login 和 list_vault_items 两个工具
```

### 5c. 创建登录 Skill

Skill 告诉 Agent 遇到登录页面时应该使用 Cerberus 来安全填充密码，而不是自己处理。

创建文件 `~/.openclaw/workspace/skills/cerberus-login/SKILL.md`，内容包括：

- **触发条件**：遇到登录页面时激活
- **MCP 工具**：`list_vault_items`（查可用凭据）和 `secure_login`（执行登录）
- **流程**：查凭据 → 分析表单 → 构造 `{{placeholder}}` 步骤 → 调用 secure_login → 验证结果
- **安全规则**：不输出密码、不绕过 MCP

Agent 在遇到登录页面时会自动读取这个 Skill，按照流程使用 Cerberus 安全登录。

## 第 6 步：测试登录！

现在你可以让 Agent 安全登录网站了。

### Agent 看到的（安全）

```
用户：帮我登录 example.com

Agent 内部流程：
1. browser open → 打开 https://example.com/login
2. browser snapshot → 看到 #email, #password 输入框
3. mcporter call cerberus.list_vault_items → 找到匹配条目
4. mcporter call cerberus.secure_login → 发送 {{email}}, {{password}} 占位符
5. browser screenshot → 确认登录成功
```

### 实际 MCP 调用

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

返回：
```json
{"status": "ok", "message": "All 4 steps completed successfully", "stepsCompleted": 4}
```

**注意**：整个过程中 Agent 只看到 `{{email}}` 和 `{{password}}`，真正的密码由 Login Router 在本地注入到浏览器，LLM 完全不知道密码是什么。

## fill vs type 怎么选？

| 方式 | 行为 | 适用场景 |
|------|------|---------|
| `fill` | 直接设值 + 触发 input/change 事件 | **默认选择** — 绝大多数网站 |
| `type` | 逐字符输入（50ms 间隔） | React/Vue 受控组件、监听 keydown 的 SPA |

**经验法则**：先试 `fill`，如果提交后报错或输入框看起来是空的，改用 `type`。

## 多步登录（银行等）

有些网站先输用户名、点下一步、再输密码。分两次调用：

```bash
# 第 1 次：填用户名 + 点下一步
npx mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "#username", "value": "{{username}}"},
    {"action": "click", "selector": "#next-btn"},
    {"action": "wait", "selector": "input[type=password]"}
  ]
}'

# 第 2 次：填密码 + 提交
npx mcporter call cerberus.secure_login --args '{
  "vaultItem": "mybank",
  "steps": [
    {"action": "type", "selector": "#password", "value": "{{password}}"},
    {"action": "click", "selector": "#login-btn"},
    {"action": "wait", "navigation": true}
  ]
}'
```

## 高级功能

### 多账号

不同 Vaultwarden 账号各自有 Bearer Token，Agent 配置多个 MCP Server 即可：

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

### 高级保护模式

在 Admin 面板中可以为敏感账户启用 **Advanced** 保护：
- 每次登录前需要在 `/approve` 页面手动解锁
- 可配合 Telegram 通知，收到审批请求后一键批准
- 50 秒超时未批准则自动拒绝

### 审计日志

访问 `http://localhost:8899/audit` 查看所有登录记录（成功、失败、限流等），密码不会被记录。

## 常见问题

| 问题 | 解决方案 |
|------|---------|
| `secure_login` 超时 | 检查 selector 是否正确；用 `browser snapshot` 确认元素存在 |
| fill 后字段为空 | 改用 `type` |
| "No exact match for vault item" | 检查 vaultItem 名称大小写是否匹配（区分大小写） |
| Tab 匹配错误 | 确保 Vaultwarden 中的 URI 与页面域名一致；必要时重启 login-router |
| 连接失败 | `docker compose logs login-router --tail 20` 查看日志 |

## 完整架构

```
OpenClaw Agent
  │
  ├─ browser snapshot/screenshot   ← 看页面结构（不含密码）
  │
  ├─ mcporter: list_vault_items    ← 查可用凭据（不含密码）
  │
  ├─ mcporter: secure_login        ← 发送 {{placeholder}} 步骤
  │     │
  │     ▼
  │   Login Router (localhost:8899)
  │     ├─ Bearer Token → 确定账户
  │     ├─ 从 Vaultwarden 取密码
  │     ├─ 替换 {{placeholder}} → 真实值
  │     ├─ 通过 CDP 注入浏览器
  │     └─ 返回 {status: "ok"}（无密码）
  │
  └─ browser screenshot            ← 验证登录结果
```

**核心原则**：LLM 永远只看到占位符，真实密码只存在于 Login Router 的内存中（用完即清），从 Vaultwarden 到 Chrome 的整条链路都在本机完成。
