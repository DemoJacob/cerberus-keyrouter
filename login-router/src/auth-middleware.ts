import type { Request, Response, NextFunction } from 'express';

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip if no token configured (backward compat)
  if (!AUTH_TOKEN) {
    next();
    return;
  }

  // Public endpoints (no auth required)
  if (req.path === '/health' || req.path === '/audit' || req.path === '/api/audit') {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (token !== AUTH_TOKEN) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}
