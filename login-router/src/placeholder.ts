import type { Step, FillStep } from './mcp-handler.js';

export interface Credentials {
  username?: string;
  email?: string;
  password?: string;
  totp?: string;
}

const PLACEHOLDER_REGEX = /\{\{(email|username|password|totp)\}\}/g;

export function replacePlaceholders(steps: Step[], credentials: Credentials): Step[] {
  return steps.map((step, i) => {
    if (step.action !== 'fill') {
      return { ...step };
    }

    const fillStep = step as FillStep;
    if (!PLACEHOLDER_REGEX.test(fillStep.value)) {
      PLACEHOLDER_REGEX.lastIndex = 0;
      return { ...fillStep };
    }
    PLACEHOLDER_REGEX.lastIndex = 0;

    const resolvedValue = fillStep.value.replace(PLACEHOLDER_REGEX, (match, key: string) => {
      // {{email}} falls back to username if email not explicitly set
      const resolvedKey = key === 'email' ? (credentials.email ?? credentials.username) : credentials[key as keyof Credentials];

      if (resolvedKey === undefined || resolvedKey === null) {
        throw new Error(`Step ${i}: placeholder {{${key}}} has no corresponding credential`);
      }

      return resolvedKey;
    });

    return { ...fillStep, value: resolvedValue };
  });
}
