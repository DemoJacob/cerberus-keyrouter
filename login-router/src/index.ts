import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './mcp-handler.js';
import { startCdpProxy } from './cdp-proxy.js';

const PORT = parseInt(process.env.MCP_PORT || '8899', 10);
const CDP_REMOTE_URL = process.env.CDP_URL || 'http://host.docker.internal:18800';

const app = express();

// Only parse JSON for non-MCP routes; MCP transport handles its own parsing
app.use((req, res, next) => {
  if (req.path === '/mcp') return next();
  express.json()(req, res, next);
});

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'cerberus-login-router',
    version: '0.1.0',
  });
  registerTools(server);
  return server;
}

// Session management
const transports = new Map<string, StreamableHTTPServerTransport>();

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
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
  const mcpServer = createMcpServer();

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

// Start CDP proxy first, then MCP server
startCdpProxy(CDP_REMOTE_URL).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cerberus login-router MCP server listening on 0.0.0.0:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });
});
