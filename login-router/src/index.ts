import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './mcp-handler.js';
import { startCdpProxy } from './cdp-proxy.js';
import { initAuditDb, queryAuditLogs } from './audit-logger.js';
import { initRateLimiter } from './rate-limiter.js';
import { authMiddleware } from './auth-middleware.js';
import { initConfigDb } from './config-db.js';
import { startAllAccounts, migrateLegacyEnv } from './account-manager.js';
import { createAdminRouter } from './admin-api.js';
import { cleanupExpiredApprovals } from './approval-manager.js';

const PORT = parseInt(process.env.MCP_PORT || '8899', 10);
const CDP_REMOTE_URL = process.env.CDP_URL || 'http://host.docker.internal:18800';

// Initialize databases
initConfigDb();
const auditDb = initAuditDb();
initRateLimiter(auditDb);

const app = express();

// Auth middleware (multi-token: routes MCP calls to correct account)
app.use(authMiddleware);

// Only parse JSON for non-MCP routes; MCP transport handles its own parsing
app.use((req, res, next) => {
  if (req.path === '/mcp') return next();
  express.json()(req, res, next);
});

function createMcpServer(req: express.Request): McpServer {
  const server = new McpServer({
    name: 'cerberus-login-router',
    version: '0.2.0',
  });
  // Pass account context so tools use the correct bw serve instance
  registerTools(server, req.account);
  return server;
}

// Session management
const transports = new Map<string, StreamableHTTPServerTransport>();

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Static HTML pages
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadHtml(filename: string): string {
  try {
    return readFileSync(path.join(__dirname, filename), 'utf-8');
  } catch {
    return `<html><body><h1>${filename} not found</h1></body></html>`;
  }
}

const auditHtml = loadHtml('audit-frontend.html');
const adminHtml = loadHtml('admin-frontend.html');
const approveHtml = loadHtml('approve-frontend.html');

app.get('/audit', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(auditHtml);
});

app.get('/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(adminHtml);
});

app.get('/approve', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(approveHtml);
});

// Admin API
app.use('/api/admin', createAdminRouter());

// Audit API
app.get('/api/audit', (req, res) => {
  try {
    const filters = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      vaultItem: req.query.vaultItem as string | undefined,
      result: req.query.result as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    };
    const data = queryAuditLogs(filters);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// MCP Streamable HTTP endpoint
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session — each session gets its own McpServer instance
  const mcpServer = createMcpServer(req);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
    },
  });

  transport.onclose = () => {
    const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
    if (sid) transports.delete(sid);
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// Startup
async function start(): Promise<void> {
  // Migrate legacy env vars if present
  await migrateLegacyEnv();

  // Start CDP proxy
  await startCdpProxy(CDP_REMOTE_URL);

  // Start expired approval cleanup (every 60 seconds)
  setInterval(cleanupExpiredApprovals, 60_000);

  // Start HTTP server first so admin panel is accessible immediately
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cerberus login-router MCP server listening on 0.0.0.0:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Admin panel:  http://localhost:${PORT}/admin`);
    console.log(`Approve page: http://localhost:${PORT}/approve`);
    console.log(`Audit log:    http://localhost:${PORT}/audit`);
  });

  // Start all configured accounts' bw serve instances in background
  // (does not block HTTP server)
  startAllAccounts().catch((err) => {
    console.error('[startup] Error starting accounts:', (err as Error).message);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
