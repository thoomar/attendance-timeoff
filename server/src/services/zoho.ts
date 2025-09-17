// server/src/services/zoho.ts

/**
 * Zoho OAuth service:
 * - Build consent URL
 * - Exchange / refresh tokens
 * - Persist tokens with robust ON CONFLICT by constraint name
 * - Cron helper: `node dist/services/zoho.js --mode=cron --windowMins=60`
 */

import { URLSearchParams } from 'url';
import * as db from '../db';

const {
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = '',
    // Optional region overrides
    ZOHO_ACCOUNTS_BASE, // e.g. "https://accounts.zoho.com" | "https://accounts.zoho.eu"
    ZOHO_API_BASE,      // e.g. "https://www.zohoapis.com" | "https://www.zohoapis.eu"
} = process.env;

/** Scopes your app requires (space-delimited). Keep in sync with your Zoho console. */
const DEFAULT_SCOPE = process.env.ZOHO_SCOPE || 'ZohoCRM.users.READ';

function accountsBase() {
    return (ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com').replace(/\/+$/, '');
}
function apiBase(fallbackFromToken?: string | null) {
    const fb = (fallbackFromToken && fallbackFromToken.trim()) || ZOHO_API_BASE || 'https://www.zohoapis.com';
    return fb.replace(/\/+$/, '');
}
function nowPlusSeconds(seconds: number) {
    const s = Math.max(0, seconds);
    return new Date(Date.now() + s * 1000);
}

/* ===================== Public API used by routes ===================== */

export function buildAuthUrl(state?: string) {
    const qp = new URLSearchParams({
        response_type: 'code',
        client_id: ZOHO_CLIENT_ID,
        scope: DEFAULT_SCOPE,
        redirect_uri: ZOHO_REDIRECT_URI,
        access_type: 'offline',
        prompt: 'consent',
    });
    if (state) qp.set('state', state);
    return `${accountsBase()}/oauth/v2/auth?${qp.toString()}`;
}

export async function handleCallback(appUserId: string, code: string) {
    // Exchange auth code -> tokens
    const tokenRes = await exchangeCode(code);

    // Fetch Zoho user info to determine stable zoho_user_id
    const who = await fetchZohoUserInfo(tokenRes.access_token, tokenRes.api_domain);
    const zohoUserId = String((who && (who.ZUID ?? who.user_id ?? who.id)) || '');

    if (!zohoUserId) {
        throw new Error('Zoho user id not found from /oauth/user/info');
    }

    await upsertTokens({
        appUserId,
        zohoUserId,
        token: tokenRes,
    });

    return { ok: true, zohoUserId };
}

export async function getStatus(appUserId?: string) {
    if (appUserId) {
        const { rows } = await db.query(
            `
                SELECT id, user_id, zoho_user_id, revoked, expires_at, scope, api_domain, token_type, updated_at
                FROM zoho_tokens
                WHERE revoked IS NOT TRUE AND user_id = $1
                ORDER BY updated_at DESC
                    LIMIT 1
            `,
            [appUserId],
        );
        return rows[0] || null;
    }
    const { rows } = await db.query(
        `
            SELECT count(*)::int AS active_count
            FROM zoho_tokens
            WHERE revoked IS NOT TRUE AND expires_at > now()
        `,
        [],
    );
    return rows[0] || { active_count: 0 };
}

/**
 * Returns a valid access token for the given app user:
 * - If near expiry, auto-refresh
 * - Throws if no token found
 */
export async function getAccessTokenForUser(appUserId: string) {
    const row = await getActiveRow(appUserId);
    if (!row) throw new Error('No Zoho token for user');

    const secondsLeft = (new Date(row.expires_at).getTime() - Date.now()) / 1000;
    if (secondsLeft <= 120) {
        const refreshed = await refreshWithRow(row);
        return refreshed.access_token;
    }
    return row.access_token as string;
}

/* ===================== Token Exchange / Refresh ===================== */

export type TokenResponse = {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    api_domain?: string;
    scope?: string;
};

async function exchangeCode(code: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code,
    });

    const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Zoho token exchange failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as TokenResponse;
}

async function refresh(refresh_token: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        refresh_token,
    });

    const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Zoho token refresh failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as TokenResponse;
}

async function fetchZohoUserInfo(access_token: string, apiDomainFromToken?: string | null) {
    const res = await fetch(`${apiBase(apiDomainFromToken)}/oauth/user/info`, {
        headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Zoho /oauth/user/info failed: ${res.status} ${txt}`);
    }
    return await res.json();
}

/* ===================== Persistence ===================== */

async function upsertTokens(args: {
    appUserId: string;
    zohoUserId: string;
    token: TokenResponse;
}) {
    const { appUserId, zohoUserId, token } = args;

    // Some Zoho responses omit fields like scope/api_domain/token_type
    const access_token = token.access_token;
    const refresh_token = token.refresh_token || (await getRefreshTokenFallback(zohoUserId));
    const token_type = token.token_type ?? null;
    const api_domain = token.api_domain ?? null;
    const scope = token.scope ?? ''; // tolerate NOT NULL schemas

    if (!access_token) throw new Error('Missing access_token');
    if (!refresh_token) throw new Error('Missing refresh_token');

    const expiresInSec = typeof token.expires_in === 'number' ? token.expires_in : 3600;
    // Refresh 60s early
    const expires_at = nowPlusSeconds(Math.max(0, expiresInSec - 60));

    // Use the *constraint name* so we never hit "no unique or exclusion constraint" when zoho_user_id is unique
    await db.query(
        `
            INSERT INTO zoho_tokens (
                user_id, access_token, refresh_token, expires_at,
                zoho_user_id, scope, api_domain, token_type, revoked, created_at, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false, now(), now())
                ON CONFLICT ON CONSTRAINT zoho_tokens_zoho_user_id_key
                DO UPDATE SET
                access_token = EXCLUDED.access_token,
                       refresh_token = EXCLUDED.refresh_token,
                       expires_at    = EXCLUDED.expires_at,
                       scope         = COALESCE(NULLIF(EXCLUDED.scope, ''), NULLIF(zoho_tokens.scope, ''), ''),
                       api_domain    = COALESCE(EXCLUDED.api_domain, zoho_tokens.api_domain),
                       token_type    = COALESCE(EXCLUDED.token_type, zoho_tokens.token_type),
                       revoked       = false,
                       updated_at    = now()
        `,
        [
            appUserId,
            access_token,
            refresh_token,
            expires_at,
            zohoUserId,
            scope,
            api_domain,
            token_type,
        ],
    );
}

async function getRefreshTokenFallback(zohoUserId: string): Promise<string | null> {
    const { rows } = await db.query(
        `
            SELECT refresh_token
            FROM zoho_tokens
            WHERE zoho_user_id = $1
            ORDER BY updated_at DESC
                LIMIT 1
        `,
        [zohoUserId],
    );
    return rows[0]?.refresh_token ?? null;
}

async function getActiveRow(appUserId: string) {
    const { rows } = await db.query(
        `
            SELECT *
            FROM zoho_tokens
            WHERE revoked IS NOT TRUE AND user_id = $1
            ORDER BY updated_at DESC
                LIMIT 1
        `,
        [appUserId],
    );
    return rows[0];
}

async function refreshWithRow(row: any): Promise<TokenResponse> {
    const token = await refresh(row.refresh_token);
    const zohoUserId = String(row.zoho_user_id);
    await upsertTokens({
        appUserId: String(row.user_id),
        zohoUserId,
        token,
    });
    return token;
}

/* ===================== Cron (used by pm2 process "zoho-refresh-cron") ===================== */

export async function refreshExpiringTokens(windowMins: number = 60) {
    // Find tokens expiring within the next window and refresh them
    const { rows } = await db.query(
        `
            SELECT *
            FROM zoho_tokens
            WHERE revoked IS NOT TRUE
              AND expires_at <= NOW() + (($1::text || ' minutes')::interval)
            ORDER BY expires_at ASC
        `,
        [String(windowMins)],
    );

    for (const row of rows) {
        try {
            await refreshWithRow(row);
            // eslint-disable-next-line no-console
            console.log(`[zoho] refreshed token for user_id=${row.user_id} zoho_user_id=${row.zoho_user_id}`);
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[zoho] refresh failed', {
                user_id: row.user_id,
                zoho_user_id: row.zoho_user_id,
                error: e?.message || String(e),
            });
        }
    }
}

/* ===================== Back-compat exports for older routes/zoho.ts ===================== */

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
    // old name expected by some routes
    return exchangeCode(code);
}

// old names some codebases use; safe aliases
export const getAuthUrl = buildAuthUrl;
export const getZohoStatus = getStatus;

export async function upsertZohoTokens(
    userId: string,
    zohoUserId: string,
    token: TokenResponse,
) {
    return upsertTokens({ appUserId: userId, zohoUserId, token });
}

/* ===================== CLI Entrypoint ===================== */

if (require.main === module) {
    (async () => {
        const argv = new Map<string, string>();
        for (let i = 2; i < process.argv.length; i++) {
            const [k, v] = process.argv[i].split('=');
            if (k) argv.set(k.replace(/^--/, '').toLowerCase(), v ?? 'true');
        }

        const mode = argv.get('mode');
        if (mode === 'cron') {
            const mins = Number(argv.get('windowmins') || '60') || 60;
            await refreshExpiringTokens(mins);
            process.exit(0);
        } else {
            // eslint-disable-next-line no-console
            console.log('[zoho] service module executed without --mode=cron; nothing to do.');
            process.exit(0);
        }
    })().catch(err => {
        // eslint-disable-next-line no-console
        console.error('[zoho] fatal', err);
        process.exit(1);
    });
}
