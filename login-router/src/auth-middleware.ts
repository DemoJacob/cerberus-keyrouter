import crypto from 'node:crypto';
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

// --- Admin session management ---

interface AdminSession {
  token: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const adminSessions = new Map<string, AdminSession>();

export function createAdminSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    token,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function validateAdminSession(token: string): boolean {
  const session = adminSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function destroyAdminSession(token: string): void {
  adminSessions.delete(token);
}

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions) {
    if (now > session.expiresAt) {
      adminSessions.delete(token);
    }
  }
}, 60_000);

// --- Path classification ---

// Truly public — no auth at all
const PUBLIC_PATHS = new Set(['/health']);

// Admin-protected pages — served as HTML (auth handled client-side via sessionStorage)
const ADMIN_HTML_PATHS = new Set(['/admin', '/audit', '/approve']);

// Admin API endpoints that don't require authentication (login flow)
const ADMIN_PUBLIC_ENDPOINTS = new Set(['/api/admin/login', '/api/admin/auth-status', '/api/admin/reset-password']);

// Admin-protected APIs — require session token
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

  // Admin public endpoints (login, auth-status) — no auth needed
  if (ADMIN_PUBLIC_ENDPOINTS.has(req.path)) {
    next();
    return;
  }

  // Admin API — check session token
  if (isAdminApiPath(req.path)) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token || !validateAdminSession(token)) {
      res.status(401).json({ error: 'Invalid or expired session' });
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
