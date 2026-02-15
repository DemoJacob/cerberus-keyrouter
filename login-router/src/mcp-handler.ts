import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateSteps, validateVaultItemName, secureClear } from './security.js';
import { replacePlaceholders, type Credentials } from './placeholder.js';
import { getCredentials, listItems } from './credential-manager.js';
import { executeSteps } from './browser-executor.js';

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

export function registerTools(server: McpServer): void {
  server.tool(
    'secure_login',
    'Execute a login sequence on the browser. Uses placeholders like {{email}}, {{username}}, {{password}}, {{totp}} that are replaced with real credentials locally. The LLM never sees the actual passwords. Use "type" action instead of "fill" for sites with frameworks (React, Angular) that need character-by-character input to trigger change events.',
    {
      vaultItem: z.string().describe('Name of the vault item to retrieve credentials from'),
      steps: z.array(StepSchema).describe('Ordered list of browser actions to execute'),
    },
    async ({ vaultItem, steps }) => {
      let credentials: Credentials | null = null;
      let resolvedSteps: Step[] | null = null;

      try {
        // 1. Validate inputs
        validateVaultItemName(vaultItem);
        validateSteps(steps);

        // 2. Fetch credentials from vault
        credentials = await getCredentials(vaultItem);

        // 3. Replace placeholders with real credentials
        resolvedSteps = replacePlaceholders(steps, credentials);

        // 4. Execute browser steps via CDP (pass URI for tab matching)
        const result = await executeSteps(resolvedSteps, credentials.uri);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: result.success ? 'ok' : 'error',
              message: result.message,
              stepsCompleted: result.stepsCompleted,
            }),
          }],
        };
      } catch (err) {
        const message = (err as Error).message || 'Unknown error';
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
        // 5. Secure cleanup
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
      try {
        const items = await listItems();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ items }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message: ((err as Error).message || 'Unknown error').slice(0, 200),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
