import { pool } from '../db';

/**
 * NOTE: We rely on env vars:
 *  - ZOHO_CLIENT_ID
 *  - ZOHO_CLIENT_SECRET
 *  - ZOHO_SCOPES (comma-separated)
 *  - ZOHO_ACCOUNTS_BASE (e.g. https://accounts.zoho.com)
 *  - ZOHO_REDIRECT_URI (e.g. https://timeoff.timesharehelpcenter.com/api/zoho/callback)
 */

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_SCOPES,
  ZOHO_ACCOUNTS_BASE,
  ZOHO_REDIRECT_URI,
} = process.env;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_SCOPES || !ZOHO_ACCOUNTS_BASE || !ZOHO_REDIRECT_URI) {
  // Don't throw at import time in case tests/scripts load this; we fail later with clear messages.
  console.warn('[zoho] Missing one or more required env vars (CLIENT_ID/SECRET/SCOPES/ACCOUNTS_BASE/REDIRECT_URI)');
}

// Use the global fetch from Node 18+ but avoid TS DOM typings;
const f: (input: any, init?: any) => Promise<any> = (globalThis as any).fetch;

/** Derive Zoho API base from accounts base (e.g., .com -> www.zohoapis.com, .eu -> www.zohoapis.eu) */
function getZohoApiBase(): string {
  try {
    const u = new URL(ZOHO_ACCOUNTS_BASE!); // e.g., https://accounts.zoho.com
    const host = u.hostname;                // accounts.zoho.com
    const tld = host.split('.').pop();      // com
    return `https://www.zohoapis.${tld}`;
  } catch {
    // fallback to US
    return 'https://www.zohoapis.com';
  }
}

/** Build the Zoho authorize URL */
export function authorizeUrl(state: string): string {
  if (!ZOHO_CLIENT_ID || !ZOHO_SCOPES || !ZOHO_REDIRECT_URI || !ZOHO_ACCOUNTS_BASE) {
    throw new Error('Zoho env vars not configured');
  }
  const auth = new URL('/oauth/v2/auth', ZOHO_ACCOUNTS_BASE);
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: ZOHO_CLIENT_ID,
    scope: ZOHO_SCOPES,
    redirect_uri: ZOHO_REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  auth.search = qs.toString();
  return auth.toString();
}

/** Exchange authorization code for tokens */
export async function exchangeCodeForToken(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}> {
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REDIRECT_URI || !ZOHO_ACCOUNTS_BASE) {
    throw new Error('Zoho env vars not configured');
  }
  const tokenUrl = new URL('/oauth/v2/token', ZOHO_ACCOUNTS_BASE);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    redirect_uri: ZOHO_REDIRECT_URI,
    code,
  });

  const resp = await f(tokenUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Zoho token exchange failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

/** Refresh access token (not used yet but useful) */
export async function refreshAccessToken(refresh_token: string): Promise<{
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}> {
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_ACCOUNTS_BASE) {
    throw new Error('Zoho env vars not configured');
  }
  const tokenUrl = new URL('/oauth/v2/token', ZOHO_ACCOUNTS_BASE);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token,
  });

  const resp = await f(tokenUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Zoho token refresh failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

/** Fetch the current Zoho user (optional, for auditing) */
export async function fetchZohoUser(accessToken: string): Promise<any> {
  const apiBase = getZohoApiBase(); // e.g., https://www.zohoapis.com
  const url = `${apiBase}/crm/v3/users?type=CurrentUser`;
  const resp = await f(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Zoho fetch user failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

export type SaveTokensInput = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  zohoUserId?: string | null;
};

/** Persist tokens into zoho_tokens (upsert by user_id) */
export async function saveZohoTokens(input: SaveTokensInput): Promise<void> {
  const { userId, accessToken, refreshToken, expiresAt, zohoUserId } = input;
  const sql = `
    INSERT INTO zoho_tokens (user_id, access_token, refresh_token, expires_at, zoho_user_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id) DO UPDATE
      SET access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          zoho_user_id = EXCLUDED.zoho_user_id,
          updated_at = NOW()
  `;
  await pool.query(sql, [userId, accessToken, refreshToken, expiresAt, zohoUserId ?? null]);
}

/** Back-compat alias for older callers (saveTokens(userId, tok)) */
export async function saveTokens(userId: string, tok: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}) {
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
  await saveZohoTokens({
    userId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt,
    zohoUserId: null,
  });
}
