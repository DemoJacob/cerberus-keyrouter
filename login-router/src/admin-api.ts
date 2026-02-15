import { Router, type Request, type Response } from 'express';
import {
  getSettings, updateSetting, getAccounts, getAccountById,
  updateAccount, type Account,
} from './config-db.js';
import {
  registerAccount, deleteAccount, restartAccount, testAccount,
  getBwServeStatus, unlockAdvancedAccount, isAccountUnlocked, lockAdvancedAccount,
  encryptPassword,
} from './account-manager.js';
import {
  approveByCode, getPendingApprovals as getPending, clearCachedMasterPassword,
} from './approval-manager.js';
import { testNotification, notifyUnlockNeeded } from './telegram-notifier.js';

function sanitizeAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    display_name: account.display_name,
    bearer_token: account.bearer_token,
    vaultwarden_url: account.vaultwarden_url,
    bw_serve_port: account.bw_serve_port,
    status: account.status,
    protection_mode: account.protection_mode,
    unlocked: isAccountUnlocked(account.id),
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

  // --- Telegram test ---

  router.post('/telegram/test', async (_req: Request, res: Response) => {
    const result = await testNotification();
    if (result.ok) {
      res.json({ ok: true, message: result.message });
    } else {
      res.status(400).json({ error: result.message });
    }
  });

  // --- Accounts ---

  router.get('/accounts', (_req: Request, res: Response) => {
    const accounts = getAccounts();
    res.json(accounts.map(sanitizeAccount));
  });

  router.post('/accounts', async (req: Request, res: Response) => {
    const { email, masterPassword, vaultwardenUrl, bearerToken, displayName, protectionMode } = req.body;

    if (!email || !masterPassword) {
      res.status(400).json({ error: 'email and masterPassword required' });
      return;
    }

    const mode = protectionMode === 'advanced' ? 'advanced' : 'standard';

    try {
      const account = await registerAccount(email, masterPassword, vaultwardenUrl, bearerToken, displayName, mode);
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

  // --- Protection mode ---

  router.post('/accounts/:id/protection-mode', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { mode, masterPassword } = req.body;
    if (mode !== 'standard' && mode !== 'advanced') {
      res.status(400).json({ error: 'mode must be "standard" or "advanced"' });
      return;
    }

    const account = getAccountById(id);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    if (mode === 'advanced') {
      // Switching to advanced: clear master_password_enc, stop bw serve, notify
      updateAccount(id, { protection_mode: 'advanced', master_password_enc: '' });
      await lockAdvancedAccount(id);
      console.log(`[admin-api] Account ${account.email} switched to advanced mode (master password removed from disk, bw serve stopped)`);
      // Send Telegram notification to prompt unlock
      await notifyUnlockNeeded(account.email);
    } else {
      // Switching to standard: need master password to re-encrypt
      if (!masterPassword) {
        res.status(400).json({ error: 'masterPassword required when switching to standard mode' });
        return;
      }
      const enc = encryptPassword(masterPassword);
      updateAccount(id, { protection_mode: 'standard', master_password_enc: enc });
      console.log(`[admin-api] Account ${account.email} switched to standard mode`);
    }

    res.json({ ok: true });
  });

  // --- Advanced mode unlock/lock ---

  router.post('/accounts/:id/unlock', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { masterPassword } = req.body;
    if (!masterPassword) {
      res.status(400).json({ error: 'masterPassword required' });
      return;
    }
    try {
      await unlockAdvancedAccount(id, masterPassword);
      res.json({ ok: true, message: 'Account unlocked and bw serve started' });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/accounts/:id/lock', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const account = getAccountById(id);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    if (account.protection_mode !== 'advanced') {
      res.status(400).json({ error: 'Only advanced mode accounts can be locked' });
      return;
    }
    lockAdvancedAccount(id);
    res.json({ ok: true, message: 'Account locked' });
  });

  router.get('/accounts/:id/unlock-status', (req: Request, res: Response) => {
    const id = req.params.id as string;
    res.json({ unlocked: isAccountUnlocked(id) });
  });

  // --- Approval management ---

  router.post('/approvals/approve', (req: Request, res: Response) => {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: 'code required' });
      return;
    }
    const result = approveByCode(String(code).trim());
    if (result.success) {
      res.json({ ok: true, message: result.message });
    } else {
      res.status(400).json({ error: result.message });
    }
  });

  router.get('/approvals/pending', (_req: Request, res: Response) => {
    const approvals = getPending();
    res.json({ approvals });
  });

  return router;
}
