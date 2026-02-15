import type { Step } from './mcp-handler.js';

const ALLOWED_ACTIONS = new Set(['fill', 'click', 'wait', 'type', 'select']);
const MAX_STEPS = 20;
const MAX_SELECTOR_LENGTH = 500;
const MAX_VALUE_LENGTH = 1000;
const MAX_VAULT_ITEM_NAME_LENGTH = 100;

const SELECTOR_BLACKLIST = [
  'javascript:',
  'onclick=',
  'onerror=',
  'onload=',
  'expression(',
  '<script',
  'data:',
  'vbscript:',
];

const PLACEHOLDER_PATTERN = /\{\{(email|username|password|totp)\}\}/g;

export function validateSteps(steps: Step[]): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Steps must be a non-empty array');
  }

  if (steps.length > MAX_STEPS) {
    throw new Error(`Too many steps: ${steps.length} (max ${MAX_STEPS})`);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (!ALLOWED_ACTIONS.has(step.action)) {
      throw new Error(`Step ${i}: invalid action "${step.action}"`);
    }

    // Validate selector (present on all actions except wait-with-navigation)
    if ('selector' in step && step.selector) {
      validateSelector(step.selector, i);
    }

    // Placeholders may only appear in fill/type value
    if (step.action === 'fill' || step.action === 'type') {
      if (step.value && step.value.length > MAX_VALUE_LENGTH) {
        throw new Error(`Step ${i}: value too long (max ${MAX_VALUE_LENGTH})`);
      }
    }

    // Ensure placeholders don't appear in selectors
    if ('selector' in step && step.selector && PLACEHOLDER_PATTERN.test(step.selector)) {
      PLACEHOLDER_PATTERN.lastIndex = 0;
      throw new Error(`Step ${i}: placeholders are not allowed in selectors`);
    }

    // For non-fill actions, ensure no placeholders in value
    if (step.action === 'select' && 'value' in step) {
      if (PLACEHOLDER_PATTERN.test(step.value)) {
        PLACEHOLDER_PATTERN.lastIndex = 0;
        throw new Error(`Step ${i}: placeholders are only allowed in fill action values`);
      }
    }
  }
}

function validateSelector(selector: string, stepIndex: number): void {
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`Step ${stepIndex}: selector too long (max ${MAX_SELECTOR_LENGTH})`);
  }

  const lower = selector.toLowerCase();
  for (const pattern of SELECTOR_BLACKLIST) {
    if (lower.includes(pattern)) {
      throw new Error(`Step ${stepIndex}: selector contains forbidden pattern "${pattern}"`);
    }
  }
}

export function validateVaultItemName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Vault item name is required');
  }

  if (name.length > MAX_VAULT_ITEM_NAME_LENGTH) {
    throw new Error(`Vault item name too long (max ${MAX_VAULT_ITEM_NAME_LENGTH})`);
  }

  // Reject shell metacharacters to prevent command injection
  const forbidden = /[;&|`$(){}[\]<>!\\'"]/;
  if (forbidden.test(name)) {
    throw new Error('Vault item name contains forbidden characters');
  }
}

export function secureClear(obj: Record<string, unknown> | null): void {
  if (!obj || typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = '';
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'object' && val[i] !== null) {
          secureClear(val[i] as Record<string, unknown>);
        } else if (typeof val[i] === 'string') {
          val[i] = '';
        }
      }
      val.length = 0;
    } else if (typeof val === 'object' && val !== null) {
      secureClear(val as Record<string, unknown>);
    }
    delete obj[key];
  }
}
