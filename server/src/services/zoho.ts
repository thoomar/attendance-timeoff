// src/services/zoho.ts
import { db } from '../db';
import { randomUUID } from 'crypto';

/** ---------------- Env ---------------- */
const {
  ZOHO_CLIENT_ID = '',
  ZOHO_CLIENT_SECRET = '',
  ZOHO_REDIRECT_URI = '',
  // Default scopes (may be overridden by env)
  ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
  // Optional hard override; otherwise infer from api_domain or ZOHO_DC
  ZOHO_ACCOUNTS_BASE = '',
  // Fallback DC when api_domain is unknown: com | eu | in | jp | com.au
  ZOHO_DC = 'com',
} = process.env;

/** ---------------- Types ---------------- */
export type ExchangedTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  apiDomain?: string; // e.g. https://www.zohoapis.eu
  tokenType?: string; // e.g. Bearer
  scope?: string;     // granted scope (if Zoho returns it)
};

export type UpsertZohoTokensInput = {
  zohoUserId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  apiDomain?: string | null;
  tokenType?: string | null;
  scope?: string | null;
};

/** ---------------- DC helpers ---------------- */
function resolveAccountsBaseFromDc(dc: string): string {
  const d = (dc || 'com').toLowerCase();
  switch (d) {
    case 'eu': return 'https://accounts.zoho.eu';
    case 'in': return 'https://accounts.zoho.in';
    case 'jp': return 'https://accounts.zoho.jp';
    case 'com.au': return 'https://accounts.zoho.com.au';
    case 'com':
    default: return 'https://accounts.zoho.com';
  }
}

/** Given an api_domain from Zoho (e.g. https://www.zohoapis.eu), choose matching Accounts base */
function resolveAccountsBaseFromApiDomain(apiDomain?: string): string {
  const d = (apiDomain || '').toLowerCase();
  if (d.endsWith('zohoapis.eu')) return 'https://accounts.zoho.eu';
  if (d.endsWith('zohoapis.in')) return 'https://accounts.zoho.in';
  if (d.endsWith('zohoapis.jp')) return 'https://accounts.zoho.jp';
  if (d.endsWith('zohoapis.com.au')) return 'https://accounts.zoho.com.au';
  return 'https://accounts.zoho.com';
}

/** Default Accounts base priority: explicit override > DC fallback */
function getDefaultAccountsBase(): string {
  if (ZOHO_ACCOUNTS_BASE) return ZOHO_ACCOUNTS_BASE;
  return resolveAccountsBaseFromDc(ZOHO_DC || 'com');
}

/** ---------------- Public API ---------------- */

/** Build the Zoho consent URL (uses prompt=consent to ensure fresh scope grant) */
export function getZohoAuthorizeUrl(scopeOverride?: string): string {
  const accounts = getDefaultAccountsBase();
  const scope = encodeURIComponent(scopeOverride || ZOHO_SCOPES);
  const clientId = encodeURIComponent(ZOHO_CLIENT_ID);
  const redirectUri = encodeURIComponent(ZOHO_REDIRECT_URI);
  const responseType = 'code';
  const access_type = 'offline'; // ask for refresh_token
  const state = encodeURIComponent(randomUUID()); // CSRF-ish state

  return `${accounts}/oauth/v2/auth?scope=${scope}&client_id=${clientId}&response_type=${responseType}&access_type=${access_type}&redirect_uri=${redirectUri}&prompt=consent&state=${state}`;
}

/** Exchange authorization code for tokens; preserve api_domain & token_type & granted scope */
export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const accounts = getDefaultAccountsBase();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    redirect_uri: ZOHO_REDIRECT_URI,
    code,
  });

  const resp = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Zoho token exchange failed: ${resp.status} ${text}`);
  }

  const json: any = await resp.json();
  const expiresIn = Number(json.expires_in ?? 3600);

  const out: ExchangedTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    apiDomain: json.api_domain,   // e.g. https://www.zohoapis.eu
    tokenType: json.token_type,   // e.g. Bearer
    scope: typeof json.scope === 'string' ? json.scope : undefined, // granted
  };

  if (!out.accessToken) {
    throw new Error('Zoho token exchange did not return access_token');
  }
  return out;
}

/**
 * Try Zoho Accounts first (needs AaaServer.profile.Read).
 * If that 401s with INVALID_OAUTHSCOPE, fall back to CRM v2 users (needs ZohoCRM.users.READ).
 * Returns a string identifier (ZUID if from Accounts, or CRM user id/email if from CRM).
 */
export async function getCurrentZohoUserId(accessToken: string, apiDomain?: string): Promise<string> {
  const accountsBase = apiDomain ? resolveAccountsBaseFromApiDomain(apiDomain) : getDefaultAccountsBase();

  // 1) Attempt Accounts
  const acctResp = await fetch(`${accountsBase}/oauth/user/info`, {
    method: 'GET',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`, // not "Bearer"
      'Content-Type': 'application/json',
    },
  });

  if (acctResp.ok) {
    const json: any = await acctResp.json();
    const zuid = String(json?.ZUID || json?.zuid || json?.Email || '');
    if (zuid) return zuid;
    // fall through to CRM if payload is weird/missing
  } else {
    // If it's an auth-scope issue, try CRM; otherwise throw the original
    const text = await acctResp.text().catch(() => '');
    const cause = (() => { try { return JSON.parse(text)?.cause; } catch { return ''; } })();
    const isScope = acctResp.status === 401 && /INVALID_OAUTHSCOPE/i.test(cause || text);
    if (!isScope) {
      throw new Error(`Failed to get current Zoho user (accounts): ${acctResp.status}  ${text}`);
    }
  }

  // 2) Fall back to CRM v2 current user (requires ZohoCRM.users.READ)
  const base = (apiDomain && apiDomain.length) ? apiDomain : 'https://www.zohoapis.com';
  const crmResp = await fetch(`${base.replace(/\/$/, '')}/crm/v2/users?type=CurrentUser`, {
    method: 'GET',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!crmResp.ok) {
    const text = await crmResp.text().catch(() => '');
    throw new Error(`Failed to get current Zoho user (crm): ${crmResp.status}  ${text}`);
  }

  const crmJson: any = await crmResp.json();
  const user = Array.isArray(crmJson?.users) ? crmJson.users[0] : undefined;
  const id = user?.id || user?.email || user?.full_name;
  if (!id) throw new Error('CRM current user response missing id/email');

  return String(id);
}

/**
 * Persist tokens.
 * Approach: revoke older active rows for the user, then insert a new row.
 * (Works with the partial unique index on (zoho_user_id) WHERE revoked IS NOT TRUE)
 */
export async function upsertZohoTokens(input: UpsertZohoTokensInput): Promise<void> {
  const id = randomUUID();
  const {
    zohoUserId,
    accessToken,
    refreshToken,
    expiresAt,
    apiDomain,
    tokenType,
    scope,
  } = input;

  // Revoke older active rows
  await db.query(
    `UPDATE zoho_tokens
       SET revoked = TRUE, updated_at = NOW()
     WHERE zoho_user_id = $1 AND revoked IS NOT TRUE`,
    [zohoUserId]
  );

  // Insert fresh row
  await db.query(
    `INSERT INTO zoho_tokens
       (id, zoho_user_id, access_token, refresh_token, expires_at, api_domain, token_type, scope, revoked, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NOW(), NOW())`,
    [
      id,
      zohoUserId,
      accessToken,
      refreshToken ?? null,
      expiresAt,
      apiDomain ?? null,
      tokenType ?? null,
      scope ?? null,
    ]
  );
}

/** Select tokens that will expire within X minutes (and not revoked) */
export async function selectTokensExpiringWithin(windowMins: number): Promise<Array<{
  id: string;
  refresh_token: string | null;
  api_domain: string | null;
}>> {
  const q = await db.query(
    `
    SELECT id, refresh_token, api_domain
    FROM zoho_tokens
    WHERE revoked IS NOT TRUE
      AND expires_at IS NOT NULL
      AND expires_at < (NOW() + ($1::int || ' minutes')::interval)
    `,
    [windowMins]
  );
  return q.rows as any[];
}

/**
 * Refresh using the right Accounts DC. Returns new access token + expiry.
 * We pass the apiDomain from the row so the refresh hits the same DC used to mint the token.
 */
export async function refreshAccessToken(refreshToken: string, apiDomain?: string): Promise<{ accessToken: string; expiresAt: Date; }> {
  const accountsBase = apiDomain ? resolveAccountsBaseFromApiDomain(apiDomain) : getDefaultAccountsBase();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const resp = await fetch(`${accountsBase}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Zoho refresh failed: ${resp.status} ${text}`);
  }

  const json: any = await resp.json();
  const expiresIn = Number(json.expires_in ?? 3600);
  const accessToken = json.access_token as string | undefined;

  if (!accessToken) {
    throw new Error('Zoho refresh did not return access_token');
  }

  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

/** Update only access token & expiry on an existing row */
export async function updateAccessTokenById(id: string, accessToken: string, expiresAt: Date): Promise<void> {
  await db.query(
    `UPDATE zoho_tokens
       SET access_token = $2,
           expires_at   = $3,
           updated_at   = NOW()
     WHERE id = $1`,
    [id, accessToken, expiresAt]
  );
}
