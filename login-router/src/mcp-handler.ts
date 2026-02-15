import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateSteps, validateVaultItemName, secureClear } from './security.js';
import { replacePlaceholders, type Credentials } from './placeholder.js';
import { getCredentials, listItems } from './credential-manager.js';
import { executeSteps, getCurrentPageUrl } from './browser-executor.js';
import { logAudit } from './audit-logger.js';
import { checkRateLimit, recordAttempt } from './rate-limiter.js';
import { verifyUrl } from './url-verifier.js';
import type { Account } from './config-db.js';
import { requestApproval, waitForApproval } from './approval-manager.js';
import { notifyLoginApproval, notifyLoginResult } from './telegram-notifier.js';
import { isAccountUnlocked } from './account-manager.js';

// --- Step type definitions ---

const FillStepSchema = z.object({
  action: z.literal('fill'),
  selector: z.string(),
  value: z.string(),
});

const ClickStepSchema = z.object({
  action: z.literal('click'),
  selector: z.string(),
});

const WaitStepSchema = z.object({
  action: z.literal('wait'),
  selector: z.string().optional(),
  navigation: z.boolean().optional(),
});

const TypeStepSchema = z.object({
  action: z.literal('type'),
  selector: z.string(),
  value: z.string(),
});

const SelectStepSchema = z.object({
  action: z.literal('select'),
  selector: z.string(),
  value: z.string(),
});

const StepSchema = z.discriminatedUnion('action', [
  FillStepSchema,
  ClickStepSchema,
  WaitStepSchema,
  TypeStepSchema,
  SelectStepSchema,
]);

export type FillStep = z.infer<typeof FillStepSchema>;
export type Step = z.infer<typeof StepSchema>;

// --- MCP Tool Registration ---

export function registerTools(server: McpServer, account?: Account): void {
  const bwServePort = account?.bw_serve_port;
  const accountLabel = account ? ` [${account.email}]` : '';

  server.tool(
    'secure_login',
    'Execute a login sequence on the browser. Uses placeholders like {{email}}, {{username}}, {{password}}, {{totp}} that are replaced with real credentials locally. The LLM never sees the actual passwords. Use "type" action instead of "fill" for sites with frameworks (React, Angular) that need character-by-character input to trigger change events.',
    {
      vaultItem: z.string().describe('Name of the vault item to retrieve credentials from'),
      steps: z.array(StepSchema).describe('Ordered list of browser actions to execute'),
    },
    async ({ vaultItem, steps }) => {
      const startTime = Date.now();
      let credentials: Credentials | null = null;
      let resolvedSteps: Step[] | null = null;
      let stepsCompleted = 0;
      let actualUrl: string | undefined;
      let urlMatchType: string | undefined;

      try {
        // 1. Validate inputs
        validateVaultItemName(vaultItem);
        validateSteps(steps);

        // 2. Check rate limit
        const rateResult = checkRateLimit(vaultItem);
        if (!rateResult.allowed) {
          logAudit({
            action: 'secure_login',
            vaultItem,
            result: 'rate_limited',
            error: rateResult.reason,
            durationMs: Date.now() - startTime,
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'error',
                message: rateResult.reason,
                retryAfter: rateResult.retryAfter,
              }),
            }],
            isError: true,
          };
        }

        // 3. Advanced mode: check unlock status and require approval
        if (account && account.protection_mode === 'advanced') {
          if (!isAccountUnlocked(account.id)) {
            logAudit({
              action: 'secure_login',
              vaultItem,
              result: 'error',
              error: 'Account is locked (advanced mode)',
              durationMs: Date.now() - startTime,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'error',
                  message: `The vault is currently locked (advanced protection mode). Please ask the user to unlock it on the /approve page, then retry.`,
                }),
              }],
              isError: true,
            };
          }

          const approval = requestApproval(account.id, vaultItem);
          console.log(`[mcp] Approval requested for ${vaultItem} (code: ${approval.approval_code}, account: ${account.email})`);

          // Send Telegram notification (non-blocking if Telegram not configured)
          await notifyLoginApproval(vaultItem, approval.approval_code, account.email);

          // Wait for approval (polls DB, max 5 minutes)
          const approved = await waitForApproval(approval.id);

          // Notify result
          await notifyLoginResult(vaultItem, approved);

          if (!approved) {
            recordAttempt(vaultItem, false);
            logAudit({
              action: 'secure_login',
              vaultItem,
              result: 'error',
              error: 'Approval denied or timed out',
              durationMs: Date.now() - startTime,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'error',
                  message: 'This login request was not approved by the user within the 2-minute window. The user has been notified via Telegram. Please ask the user to check their Telegram notifications and approve the request on the /approve page, then retry.',
                }),
              }],
              isError: true,
            };
          }
        }

        // 4. Fetch credentials from vault (using account's bw serve port)
        credentials = await getCredentials(vaultItem, bwServePort);

        // 4. Verify URL matches vault URI
        try {
          actualUrl = await getCurrentPageUrl(credentials.uri);
          const urlResult = verifyUrl(actualUrl, credentials.uri);
          urlMatchType = urlResult.matchType;

          if (!urlResult.allowed) {
            recordAttempt(vaultItem, false);
            logAudit({
              action: 'secure_login',
              vaultItem,
              actualUrl,
              vaultUri: credentials.uri,
              urlMatch: urlResult.matchType,
              username: credentials.username ?? credentials.email,
              result: 'url_mismatch',
              error: urlResult.reason,
              durationMs: Date.now() - startTime,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'error',
                  message: urlResult.reason,
                }),
              }],
              isError: true,
            };
          }
        } catch {
          // If we can't get the page URL, log warning but continue
          urlMatchType = 'unknown';
        }

        // 5. Replace placeholders with real credentials
        resolvedSteps = replacePlaceholders(steps, credentials);

        // 6. Execute browser steps via CDP (pass URI for tab matching)
        const result = await executeSteps(resolvedSteps, credentials.uri);
        stepsCompleted = result.stepsCompleted;

        const success = result.success;
        recordAttempt(vaultItem, success);
        logAudit({
          action: 'secure_login',
          vaultItem,
          actualUrl,
          vaultUri: credentials.uri,
          urlMatch: urlMatchType,
          username: credentials.username ?? credentials.email,
          result: success ? 'success' : 'error',
          error: success ? undefined : result.message,
          stepsCompleted,
          durationMs: Date.now() - startTime,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: success ? 'ok' : 'error',
              message: result.message,
              stepsCompleted: result.stepsCompleted,
            }),
          }],
        };
      } catch (err) {
        const message = (err as Error).message || 'Unknown error';
        recordAttempt(vaultItem, false);
        logAudit({
          action: 'secure_login',
          vaultItem,
          actualUrl,
          vaultUri: credentials?.uri,
          urlMatch: urlMatchType,
          username: credentials?.username ?? credentials?.email,
          result: 'error',
          error: message,
          stepsCompleted,
          durationMs: Date.now() - startTime,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message: message.slice(0, 200),
            }),
          }],
          isError: true,
        };
      } finally {
        // Secure cleanup
        if (credentials) secureClear(credentials as unknown as Record<string, unknown>);
        if (resolvedSteps) {
          for (const step of resolvedSteps) {
            secureClear(step as unknown as Record<string, unknown>);
          }
        }
      }
    }
  );

  server.tool(
    'list_vault_items',
    'List available login items in the vault. Returns site names and usernames only — no passwords are included.',
    {},
    async () => {
      const startTime = Date.now();
      try {
        const items = await listItems(bwServePort);
        logAudit({
          action: 'list_vault_items',
          result: 'success',
          durationMs: Date.now() - startTime,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ items }),
          }],
        };
      } catch (err) {
        const message = ((err as Error).message || 'Unknown error').slice(0, 200);
        logAudit({
          action: 'list_vault_items',
          result: 'error',
          error: message,
          durationMs: Date.now() - startTime,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
