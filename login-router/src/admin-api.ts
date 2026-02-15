import { Router, type Request, type Response } from 'express';
import {
  getSettings, updateSetting, getAccounts, getAccountById,
  updateAccount, type Account,
} from './config-db.js';
import {
  registerAccount, deleteAccount, restartAccount, testAccount,
  getBwServeStatus,
} from './account-manager.js';

function sanitizeAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    display_name: account.display_name,
    bearer_token: account.bearer_token,
    vaultwarden_url: account.vaultwarden_url,
    bw_serve_port: account.bw_serve_port,
    status: account.status,
    bw_serve_status: getBwServeStatus(account.id),
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

export function createAdminRouter(): Router {
  const router = Router();
  // Auth is handled by authMiddleware in auth-middleware.ts

  // --- Settings ---

  router.get('/settings', (_req: Request, res: Response) => {
    res.json(getSettings());
  });

  router.put('/settings', (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      res.status(400).json({ error: 'key and value required' });
      return;
    }
    updateSetting(key, value);
    res.json({ ok: true });
  });

  // --- Accounts ---

  router.get('/accounts', (_req: Request, res: Response) => {
    const accounts = getAccounts();
    res.json(accounts.map(sanitizeAccount));
  });

  router.post('/accounts', async (req: Request, res: Response) => {
    const { email, masterPassword, vaultwardenUrl, bearerToken, displayName } = req.body;

    if (!email || !masterPassword) {
      res.status(400).json({ error: 'email and masterPassword required' });
      return;
    }

    try {
      const account = await registerAccount(email, masterPassword, vaultwardenUrl, bearerToken, displayName);
      res.json({
        ok: true,
        account: sanitizeAccount(account),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put('/accounts/:id', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { bearer_token, display_name, status, vaultwarden_url } = req.body;

    const account = getAccountById(id);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const updated = updateAccount(id, {
      bearer_token,
      display_name,
      status,
      vaultwarden_url,
    });

    res.json({ ok: true, account: updated ? sanitizeAccount(updated) : null });
  });

  router.delete('/accounts/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const account = getAccountById(id);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    try {
      await deleteAccount(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/accounts/:id/test', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await testAccount(id);
    res.json(result);
  });

  router.post('/accounts/:id/restart', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      await restartAccount(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
