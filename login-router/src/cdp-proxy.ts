import * as http from 'node:http';
import * as net from 'node:net';

const PROXY_PORT = 9222;
const PROXY_HOST = '127.0.0.1';

/**
 * Tiny HTTP + WebSocket reverse proxy that rewrites the Host header
 * to "localhost" so Chrome CDP accepts connections from Docker containers.
 * Also rewrites webSocketDebuggerUrl in /json responses to point back
 * to the proxy, preventing Playwright from bypassing it.
 */
export function startCdpProxy(targetUrl: string): Promise<void> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = parseInt(target.port || '9222', 10);

  const server = http.createServer((req, res) => {
    const isJsonEndpoint = req.url?.startsWith('/json');

    const proxyReq = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `localhost:${targetPort}` },
      },
      (proxyRes) => {
        if (isJsonEndpoint) {
          // Buffer response to rewrite WebSocket URLs
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf-8');
            // Rewrite ws://localhost:PORT and ws://HOST:PORT to point to proxy
            body = body.replace(
              /ws:\/\/[^/]+/g,
              `ws://${PROXY_HOST}:${PROXY_PORT}`,
            );
            const headers = { ...proxyRes.headers };
            headers['content-length'] = String(Buffer.byteLength(body));
            res.writeHead(proxyRes.statusCode ?? 502, headers);
            res.end(body);
          });
        } else {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      },
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502);
      res.end(`CDP proxy error: ${err.message}`);
    });

    req.pipe(proxyReq);
  });

  // WebSocket upgrade (CDP uses WebSocket for the actual protocol)
  server.on('upgrade', (req, socket, head) => {
    const proxySocket = net.connect(targetPort, targetHost, () => {
      const headers = { ...req.headers, host: `localhost:${targetPort}` };
      const headerLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');

      proxySocket.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headerLines}\r\n\r\n`,
      );

      if (head.length > 0) {
        proxySocket.write(head);
      }

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxySocket.on('error', () => socket.end());
    socket.on('error', () => proxySocket.end());
  });

  return new Promise((resolve, reject) => {
    server.listen(PROXY_PORT, PROXY_HOST, () => {
      console.log(`CDP proxy listening on ${PROXY_HOST}:${PROXY_PORT} -> ${targetHost}:${targetPort}`);
      resolve();
    });
    server.on('error', reject);
  });
}

export const CDP_PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
