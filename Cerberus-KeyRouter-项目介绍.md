# Cerberus KeyRouter — 项目介绍

> 本文档是 Cerberus KeyRouter 的完整项目概况，供 Howler（营销 Agent）撰写推广内容时参考。

## 一句话定位

**让 AI Agent 安全登录网站的开源 MCP 服务器 — 密码全程不经过 LLM。**

## 项目信息

| 项目 | 内容 |
|------|------|
| 名称 | Cerberus KeyRouter |
| GitHub | https://github.com/DemoJacob/cerberus-keyrouter |
| 协议 | AGPL-3.0 |
| 作者 | DemoJacob |
| 语言 | TypeScript / Node.js |
| 依赖 | Vaultwarden, Playwright, Docker |
| 协议 | MCP (Model Context Protocol) |

## 解决的核心问题

当 AI Agent（如 OpenClaw、Claude Desktop、Cursor 等）需要自动化浏览器操作时，遇到登录页面怎么办？

**传统方式的问题：**
- 密码直接写在 prompt 里 → 发送到云端 LLM → 被日志记录 → 可能被 prompt injection 泄露
- 或者手动登录 → 丧失了自动化的意义

**Cerberus 的方案：**
- 密码存储在本地 Vaultwarden（自托管 Bitwarden）中，E2E 加密
- Agent 只使用 `{{email}}` / `{{password}}` 占位符构造登录步骤
- Login Router 在本地将占位符替换为真实密码，通过 Chrome CDP 注入浏览器
- LLM 从头到尾不知道密码是什么

## 核心架构

```
AI Agent (任何 MCP 兼容的 Agent)
  │
  │  MCP 调用：secure_login("GitHub", steps: [
  │    {fill, "#email", "{{email}}"},
  │    {fill, "#password", "{{password}}"},
  │    {click, "#submit"}
  │  ])
  │
  ▼
Login Router (localhost:8899)
  ├─ Bearer Token 认证 → 确定 Vaultwarden 账户
  ├─ 从 Vaultwarden 取真实密码
  ├─ 替换 {{placeholder}} → 真实值
  ├─ 通过 Chrome CDP 协议注入浏览器
  ├─ 用完立即清除内存中的密码
  └─ 返回 {status: "ok"}（不含密码）
```

## 功能亮点

### 🔐 零知识设计
- LLM 永远看不到明文密码
- 占位符只允许出现在 fill/type 的 value 字段，selector 中使用会被拒绝
- 密码用完立即从内存清除

### 🏦 多账户支持
- 一个 Login Router 管理多个 Vaultwarden 账户
- 每个账户有独立的 Bearer Token
- 适合个人账户 vs 工作账户分离

### 🛡️ 六层安全防护
1. **URL 验证** — Login Router 通过 CDP 读取浏览器实际 URL，与 Vault 中的 URI 比对，防止钓鱼
2. **两级保护模式** — Standard（自动解锁）适合日常账户；Advanced（手动解锁 + 审批）适合银行等敏感账户
3. **确认码审批** — Advanced 模式下，每次登录生成 4 位确认码，需在 `/approve` 页面或 Admin 面板输入确认（50s 超时自动拒绝）
4. **Bearer Token 认证** — 每个账户独立 token，防止未授权访问
5. **限流** — 每分钟 3 次、每小时 20 次，失败后冷却
6. **审计日志** — 完整记录所有操作（成功、失败、限流），不记录密码

### 📱 Telegram 集成
- **实时通知** — 解锁成功、登录审批请求、执行结果通知推送到 Telegram
- **审批请求含确认码** — 收到通知后在 `/approve` 页面输入 4 位确认码即可批准
- **一键配置** — Admin 面板中 Test & Save，验证通过再保存
- 支持自定义 Bot Token 和 Chat ID

### 🎛️ Web Admin 面板
- Session-based 认证（PBKDF2-SHA256 哈希密码，首次登录用 VW_ADMIN_TOKEN，之后设置个人密码）
- 忘记密码可用 VW_ADMIN_TOKEN 重置
- AES-256-GCM 加密存储 Vaultwarden 主密码
- 一键添加/删除/测试账户
- 一键复制 MCP 配置 JSON
- 直接 Unlock / Lock Advanced 模式账户
- 可视化 bw serve 状态
- 配置 Telegram 通知（Test & Save 一键验证）

### 🧩 MCP 标准协议
- 兼容所有支持 MCP 的 AI Agent
- 两个工具：`list_vault_items`（列出可用站点）、`secure_login`（执行登录）
- Streamable HTTP 传输

### 🔄 灵活的表单填充
- `fill` — 标准表单（直接设值 + input/change 事件）
- `type` — React/SPA（逐字符输入，50ms 间隔）
- 支持多步登录（分次调用，处理 SPA 页面切换）

### 🔍 智能 Tab 匹配
- 根据 URL 域名自动找到正确的浏览器 Tab
- 多个同域名 Tab 时，通过 CSS selector 检测定位正确页面
- 优先匹配最新打开的 Tab

## 技术栈

- **运行环境**：Docker Compose（Vaultwarden + Login Router）
- **后端**：TypeScript, Node.js, Express
- **浏览器自动化**：Playwright-core (connectOverCDP)
- **密码管理**：Vaultwarden (Bitwarden CLI `bw serve`)
- **协议**：MCP (Model Context Protocol), Streamable HTTP
- **存储**：SQLite (配置 + 审计日志)
- **加密**：AES-256-GCM (存储密码), PBKDF2-SHA256 (管理员密码)

## 已验证的登录场景

| 网站 | 方式 | 特点 |
|------|------|------|
| zooplus.de | `fill` | Keycloak 标准表单，单页登录 |
| iPKO (PKO Bank) | `type` | 两步 SPA，需手机验证 |
| agentta.ai | `type` | 标准表单，React 应用 |

## 部署方式

```bash
git clone https://github.com/DemoJacob/cerberus-keyrouter.git
cd cerberus-keyrouter
cp .env.example .env
# 设置 VW_ADMIN_TOKEN
docker compose up --build -d
```

唯一必需的环境变量：`VW_ADMIN_TOKEN`（用于首次 Admin 登录和密码重置）。
其他所有配置通过 Admin Web 面板管理。

## 目标用户

1. **AI Agent 开发者** — 需要让 Agent 安全访问需登录的网站
2. **OpenClaw / Claude Desktop / Cursor 用户** — 使用 MCP 生态的个人用户
3. **安全研究者** — 关注 AI Agent 安全的人
4. **自托管爱好者** — 已经在用 Vaultwarden，想扩展用途

## 竞争优势 / 差异化

- **唯一**专门解决 AI Agent 登录密码安全问题的开源项目
- 基于 **MCP 标准协议**，不绑定特定 Agent 框架
- 使用成熟的 **Vaultwarden** 作为密码后端，不重复造轮子
- **六层安全防护** + Telegram 人工审批，不是简单的密码转发
- **Web Admin 面板**，非技术用户也能配置

## 推广关键词

### 中文
- AI Agent 安全登录
- MCP 密码管理
- 浏览器自动化安全
- Vaultwarden MCP
- LLM 不碰密码

### 英文
- AI agent secure login
- MCP password router
- Browser automation security
- Zero-knowledge credentials for LLM
- Vaultwarden MCP integration

## 推广平台规划

### 中文社区
- 掘金 / 知乎 — 深度技术文章（架构设计 + 安全分析）
- 小红书 — 3 篇笔记（科普 → 产品 → 技术）
- V2EX — 创意工区发帖

### 英文社区
- Hacker News — Show HN
- Reddit — r/selfhosted, r/LocalLLaMA, r/MCP
- Dev.to / Medium — 技术博客
- awesome-mcp-servers — PR 提交
- GitHub Topics — `mcp`, `ai-agent`, `browser-automation`, `password-security`, `vaultwarden`

## 素材需求

- [ ] 架构图（PNG，清晰标注数据流向和安全边界）
- [ ] Demo GIF（15s，展示 Agent 登录过程）
- [ ] Demo 视频（2-3 分钟，完整演示）
- [ ] 中文技术博客（3000-5000 字）
- [ ] 英文技术博客（1500-2500 words）
- [ ] 小红书封面图 × 3

## 项目路线图

### 已完成 ✅
- 核心 MCP Server（secure_login, list_vault_items）
- 多账户 + Bearer Token
- Admin Web 面板（Session-based 认证 + 密码管理）
- 两级保护模式（Standard / Advanced）
- Telegram 集成（通知 + 审批推送）
- 4 位确认码审批流程（50s 超时）
- 智能 Tab 匹配（域名 + selector 检测）
- 六层安全防护
- 审计日志
- AGPL-3.0 开源

### 计划中 🗓️
- Cookie 缓存（登录一次，复用会话）
- 支持 OpenClaw snapshot ref ID（除 CSS selector 外）
- 多 Agent 框架支持
- SaaS 版本（Phase 2）
