export type UrlMatchType = 'exact' | 'subdomain' | 'no_uri_configured' | 'mismatch';

export interface UrlVerifyResult {
  allowed: boolean;
  matchType: UrlMatchType;
  reason?: string;
}

export function verifyUrl(actualUrl: string, vaultUri?: string): UrlVerifyResult {
  if (!vaultUri) {
    return {
      allowed: true,
      matchType: 'no_uri_configured',
      reason: 'No URI configured in vault item — allowing with warning',
    };
  }

  let actualHost: string;
  let vaultHost: string;
  try {
    actualHost = new URL(actualUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return {
      allowed: false,
      matchType: 'mismatch',
      reason: `Invalid browser URL: ${actualUrl.slice(0, 100)}`,
    };
  }

  try {
    vaultHost = new URL(vaultUri).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return {
      allowed: true,
      matchType: 'no_uri_configured',
      reason: `Invalid vault URI format: ${vaultUri.slice(0, 100)} — treating as unconfigured`,
    };
  }

  if (actualHost === vaultHost) {
    return { allowed: true, matchType: 'exact' };
  }

  if (actualHost.endsWith('.' + vaultHost) || vaultHost.endsWith('.' + actualHost)) {
    return { allowed: true, matchType: 'subdomain' };
  }

  return {
    allowed: false,
    matchType: 'mismatch',
    reason: `URL mismatch: browser is on "${actualHost}" but vault expects "${vaultHost}"`,
  };
}
