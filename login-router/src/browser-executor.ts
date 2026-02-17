import { chromium, type Browser, type Page } from 'playwright-core';
import type { Step } from './mcp-handler.js';
import { CDP_PROXY_URL } from './cdp-proxy.js';

// Always connect via the local CDP proxy which rewrites Host header
const CDP_URL = CDP_PROXY_URL;
const STEP_TIMEOUT = 10_000;
const MAX_CONNECT_RETRIES = 2;
const ERROR_MESSAGE_MAX_LENGTH = 200;

let browserInstance: Browser | null = null;

async function getConnectedBrowser(): Promise<Browser> {
  // Always reconnect to get fresh page URLs from CDP
  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
  }
  // Reconnecting to CDP

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

async function getActivePage(browser: Browser, targetUrl?: string, steps?: Step[]): Promise<Page> {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts available');
  }

  // Collect all pages across all contexts
  const allPages: Page[] = [];
  for (const ctx of contexts) {
    allPages.push(...ctx.pages());
  }

  if (allPages.length === 0) {
    throw new Error('No pages available in browser context');
  }

  // If targetUrl provided, find matching pages by domain
  if (targetUrl) {
    try {
      const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '');
      const matched = allPages.filter(p => {
        try {
          const pageHost = new URL(p.url()).hostname.replace(/^www\./, '');
          return pageHost === targetHost || pageHost.endsWith('.' + targetHost);
        } catch { return false; }
      });

      if (matched.length === 1) return matched[0];

      if (matched.length > 1) {
        // Multiple tabs with same domain — check which has the first step's selector
        const firstSelector = steps?.find(s => 'selector' in s && s.selector)?.selector;
        if (firstSelector) {
          // Check from newest to oldest (last in array = newest)
          for (let i = matched.length - 1; i >= 0; i--) {
            try {
              const count = await matched[i].locator(firstSelector).count();
              if (count > 0) {
                console.log(`[browser] Matched tab ${i + 1}/${matched.length} by selector "${firstSelector}": ${matched[i].url()}`);
                return matched[i];
              }
            } catch { /* selector check failed, try next */ }
          }
          console.log(`[browser] No tab has selector "${firstSelector}", using newest of ${matched.length} matched tabs`);
        }
        // No selector match or no steps — return newest tab
        return matched[matched.length - 1];
      }
    } catch { /* fall through to default */ }
  }

  // Prefer the last non-blank page (most recently opened)
  const nonBlank = allPages.filter(p => {
    const u = p.url();
    return u && u !== 'about:blank' && !u.startsWith('chrome-error://');
  });
  return nonBlank.length > 0 ? nonBlank[nonBlank.length - 1] : allPages[allPages.length - 1];
}

export async function executeSteps(steps: Step[], targetUrl?: string): Promise<{ success: boolean; message: string; stepsCompleted: number }> {
  const browser = await getConnectedBrowser();
  const page = await getActivePage(browser, targetUrl, steps);

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
      // Dispatch events for React/Angular/Vue frameworks that ignore programmatic fill
      await locator.dispatchEvent('input', { bubbles: true });
      await locator.dispatchEvent('change', { bubbles: true });
      break;
    }

    case 'type': {
      const locator = page.locator(step.selector);
      await locator.click({ timeout: STEP_TIMEOUT });
      await locator.pressSequentially(step.value, { delay: 50, timeout: STEP_TIMEOUT });
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

export async function getCurrentPageUrl(targetUrl?: string): Promise<string> {
  const browser = await getConnectedBrowser();
  const page = await getActivePage(browser, targetUrl);
  return page.url();
}

function truncateError(message?: string): string {
  if (!message) return 'Unknown error';
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}
