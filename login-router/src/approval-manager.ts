import crypto from 'node:crypto';
import {
  generateId,
  createPendingApproval as dbCreateApproval,
  getPendingApprovalByCode,
  getPendingApprovalById,
  getPendingApprovals as dbGetPending,
  updateApprovalStatus,
  cleanupExpiredApprovals as dbCleanup,
  type PendingApproval,
} from './config-db.js';

// --- In-memory master password cache ---
// Key: accountId, Value: { password, expiresAt (epoch ms) }
const masterPasswordCache = new Map<string, { password: string; expiresAt: number }>();

const DEFAULT_CACHE_TTL = 8 * 60 * 60; // 8 hours in seconds
const APPROVAL_EXPIRY_SECONDS = 50; // 50 seconds (within MCP 60s timeout)

export function cacheMasterPassword(accountId: string, password: string, ttlSeconds: number = DEFAULT_CACHE_TTL): void {
  masterPasswordCache.set(accountId, {
    password,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export function getCachedMasterPassword(accountId: string): string | null {
  const entry = masterPasswordCache.get(accountId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    masterPasswordCache.delete(accountId);
    return null;
  }
  return entry.password;
}

export function clearCachedMasterPassword(accountId: string): void {
  masterPasswordCache.delete(accountId);
}

export function clearAllCachedPasswords(): void {
  masterPasswordCache.clear();
}

export function isMasterPasswordCached(accountId: string): boolean {
  return getCachedMasterPassword(accountId) !== null;
}

// --- Approval codes ---

function generateApprovalCode(): string {
  // 4-digit code (0000-9999)
  return String(crypto.randomInt(10000)).padStart(4, '0');
}

export function requestApproval(accountId: string, vaultItem: string): PendingApproval {
  const expiresAt = new Date(Date.now() + APPROVAL_EXPIRY_SECONDS * 1000).toISOString().replace('T', ' ').replace('Z', '');
  return dbCreateApproval({
    id: generateId(),
    account_id: accountId,
    vault_item: vaultItem,
    approval_code: generateApprovalCode(),
    status: 'pending',
    expires_at: expiresAt,
  });
}

export function approveByCode(code: string): { success: boolean; message: string; approval?: PendingApproval } {
  const approval = getPendingApprovalByCode(code);
  if (!approval) {
    return { success: false, message: 'Invalid or expired approval code' };
  }
  updateApprovalStatus(approval.id, 'approved');
  const updated = getPendingApprovalById(approval.id)!;
  return { success: true, message: `Approved login for ${approval.vault_item}`, approval: updated };
}

export function rejectApproval(id: string): void {
  updateApprovalStatus(id, 'rejected');
}

export function checkApprovalStatus(approvalId: string): PendingApproval | undefined {
  return getPendingApprovalById(approvalId);
}

export function getPendingApprovals(): PendingApproval[] {
  return dbGetPending();
}

export function cleanupExpiredApprovals(): void {
  dbCleanup();
  // Also clean expired password cache entries
  for (const [id, entry] of masterPasswordCache) {
    if (Date.now() > entry.expiresAt) {
      masterPasswordCache.delete(id);
    }
  }
}

// --- Approval polling (used by mcp-handler) ---

export async function waitForApproval(approvalId: string, timeoutMs: number = APPROVAL_EXPIRY_SECONDS * 1000): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - start < timeoutMs) {
    const approval = getPendingApprovalById(approvalId);
    if (!approval) return false;
    if (approval.status === 'approved') return true;
    if (approval.status === 'rejected' || approval.status === 'expired') return false;
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Timed out — mark as expired
  updateApprovalStatus(approvalId, 'expired');
  return false;
}
