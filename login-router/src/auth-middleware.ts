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

const PUBLIC_PATHS = new Set(['/health', '/audit', '/api/audit', '/admin']);

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Public endpoints — no auth required
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/admin')) {
    next();
    return;
  }

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
