import type { Request, Response, NextFunction } from 'express';
import { getAccountByToken, type Account } from './config-db.js';

// Extend Express Request to carry account info
declare global {
  namespace Express {
    interface Request {
      account?: Account;
    }
  }
}

const ADMIN_TOKEN = process.env.VW_ADMIN_TOKEN || '';

// Truly public — no auth at all
const PUBLIC_PATHS = new Set(['/health']);

// Admin-protected pages — served as HTML (auth handled client-side via sessionStorage)
const ADMIN_HTML_PATHS = new Set(['/admin', '/audit', '/approve']);

// Admin-protected APIs — require Bearer admin token
const ADMIN_API_PREFIXES = ['/api/admin', '/api/audit'];

function isAdminApiPath(path: string): boolean {
  return ADMIN_API_PREFIXES.some(p => path.startsWith(p));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Truly public
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  // Admin HTML pages — always serve (client-side login handles auth)
  if (ADMIN_HTML_PATHS.has(req.path)) {
    next();
    return;
  }

  // Admin API — check admin token
  if (isAdminApiPath(req.path)) {
    if (!ADMIN_TOKEN) {
      res.status(503).json({ error: 'VW_ADMIN_TOKEN not configured' });
      return;
    }
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token || token !== ADMIN_TOKEN) {
      res.status(401).json({ error: 'Invalid admin token' });
      return;
    }
    next();
    return;
  }

  // MCP endpoints — check account bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header required. Use Bearer <token> from admin panel.' });
    return;
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  const account = getAccountByToken(token);
  if (!account) {
    res.status(403).json({ error: 'Invalid or inactive bearer token' });
    return;
  }

  req.account = account;
  next();
}
