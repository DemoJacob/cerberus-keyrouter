import { chromium, type Browser, type Page } from 'playwright-core';
import type { Step } from './mcp-handler.js';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:18800';
const STEP_TIMEOUT = 10_000;
const MAX_CONNECT_RETRIES = 2;
const ERROR_MESSAGE_MAX_LENGTH = 200;

let browserInstance: Browser | null = null;

async function getConnectedBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    try {
      browserInstance = await chromium.connectOverCDP(CDP_URL);
      return browserInstance;
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_CONNECT_RETRIES) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw new Error(`Failed to connect to CDP at ${CDP_URL}: ${truncateError(lastError?.message)}`);
}

async function getActivePage(browser: Browser): Promise<Page> {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts available');
  }

  const pages = contexts[0].pages();
  if (pages.length === 0) {
    throw new Error('No pages available in browser context');
  }

  return pages[0];
}

export async function executeSteps(steps: Step[]): Promise<{ success: boolean; message: string; stepsCompleted: number }> {
  const browser = await getConnectedBrowser();
  const page = await getActivePage(browser);

  let stepsCompleted = 0;

  try {
    for (const step of steps) {
      await executeStep(page, step);
      stepsCompleted++;
    }

    return {
      success: true,
      message: `All ${stepsCompleted} steps completed successfully`,
      stepsCompleted,
    };
  } catch (err) {
    const message = truncateError((err as Error).message);
    return {
      success: false,
      message: `Failed at step ${stepsCompleted}: ${message}`,
      stepsCompleted,
    };
  }
  // Note: we do NOT call browser.close() to avoid closing the host Chrome
}

async function executeStep(page: Page, step: Step): Promise<void> {
  switch (step.action) {
    case 'fill': {
      const locator = page.locator(step.selector);
      await locator.fill(step.value, { timeout: STEP_TIMEOUT });
      break;
    }

    case 'click': {
      const locator = page.locator(step.selector);
      await locator.click({ timeout: STEP_TIMEOUT });
      break;
    }

    case 'wait': {
      if (step.navigation) {
        await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT });
      } else if (step.selector) {
        const locator = page.locator(step.selector);
        await locator.waitFor({ timeout: STEP_TIMEOUT });
      }
      break;
    }

    case 'select': {
      const locator = page.locator(step.selector);
      await locator.selectOption(step.value, { timeout: STEP_TIMEOUT });
      break;
    }
  }
}

function truncateError(message?: string): string {
  if (!message) return 'Unknown error';
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}
