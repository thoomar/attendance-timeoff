// server/src/services/zoho.ts
import { db } from '../db';

const {
    ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com',
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = '',
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
} = process.env;

/** ---------- Types ---------- */
export type ExchangeTokenResponse = {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number; // seconds
    scope?: string;
    api_domain?: string;
};

export type SaveTokensInput = {
    zohoUserId: string;
    accessToken: string;
    refreshToken?: string | null; // optional; we’ll reuse existing if absent
    scope?: string | null;        // optional; defaults to ZOHO_SCOPES
    expiresIn?: number | null;    // seconds; defaults to 3600 if absent
    tokenType?: string | null;    // optional
    apiDomain?: string | null;    // optional
};

/** Small helper to ensure we never store an absurd expiresAt */
function computeExpiresAt(expiresInSeconds?: number | null): Date {
    const seconds = typeof expiresInSeconds === 'number' && expiresInSeconds > 0
        ? expiresInSeconds
        : 3600; // 1 hour fallback
    return new Date(Date.now() + seconds * 1000);
}

/** ---------- OAuth: exchange auth code for tokens ---------- */
export async function exchangeCodeForToken(code: string): Promise<ExchangeTokenResponse> {
    const tokenUrl = new URL('/oauth/v2/token', ZOHO_ACCOUNTS_BASE);
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID!,
        client_secret: ZOHO_CLIENT_SECRET!,
        redirect_uri: ZOHO_REDIRECT_URI!,
        code,
    });

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Zoho token exchange failed: ${resp.status} ${txt}`);
    }

    const data = (await resp.json()) as ExchangeTokenResponse;
    return data;
}

/** ---------- Tokens: save/upsert using your partial unique constraint ---------- */
export async function saveZohoTokens(input: SaveTokensInput): Promise<void> {
    const {
        zohoUserId,
        accessToken,
        refreshToken: refreshTokenCandidate,
        scope: scopeCandidate,
        expiresIn,
        tokenType,
        apiDomain,
    } = input;

    // 1) If no refreshToken provided, try to reuse existing ACTIVE (revoked IS NOT TRUE) row’s refresh_token
    let refreshTokenFinal: string | null | undefined = refreshTokenCandidate ?? null;
    if (!refreshTokenFinal) {
        const sel = await db.query<{
            refresh_token: string | null;
        }>(
            `
      SELECT refresh_token
      FROM zoho_tokens
      WHERE zoho_user_id = $1
        AND revoked IS NOT TRUE
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1
      `,
            [zohoUserId]
        );
        refreshTokenFinal = sel.rows[0]?.refresh_token ?? null;
    }

    // Your table has "refresh_token TEXT NOT NULL", so we must not INSERT null.
    // If still missing, force caller to re-consent (Zoho will return a refresh_token with prompt=consent + access_type=offline).
    if (!refreshTokenFinal) {
        throw new Error(
            'Missing refresh_token and no active token to reuse. Ask the user to reconnect Zoho (consent required).'
        );
    }

    // 2) Fill required/optional fields
    const scopeFinal = scopeCandidate ?? ZOHO_SCOPES;
    const expiresAt = computeExpiresAt(expiresIn); // timestamptz value
    const tokenTypeFinal = tokenType ?? null;
    const apiDomainFinal = apiDomain ?? null;

    // 3) Upsert using your existing partial unique constraint:
    //    uniq_zoho_tokens_active_user UNIQUE (zoho_user_id) WHERE revoked IS NOT TRUE
    //    This lets you keep historical rows (revoked = TRUE) while guaranteeing one active row per user.
    await db.query(
        `
    INSERT INTO zoho_tokens (
      zoho_user_id, access_token, refresh_token, scope, expires_at,
      token_type, api_domain, revoked, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, FALSE, now(), now()
    )
    ON CONFLICT ON CONSTRAINT uniq_zoho_tokens_active_user
    DO UPDATE SET
      access_token  = EXCLUDED.access_token,
      -- keep the existing refresh_token if the new one is null/empty:
      refresh_token = COALESCE(NULLIF(EXCLUDED.refresh_token, ''), zoho_tokens.refresh_token),
      scope         = EXCLUDED.scope,
      expires_at    = EXCLUDED.expires_at,
      token_type    = EXCLUDED.token_type,
      api_domain    = EXCLUDED.api_domain,
      updated_at    = now()
    `,
        [
            zohoUserId,
            accessToken,
            refreshTokenFinal,
            scopeFinal,
            expiresAt,
            tokenTypeFinal,
            apiDomainFinal,
        ]
    );
}

/** ---------- (Optional) helper to revoke older duplicates if you ever switch to a global unique ----------
 *
 * If you ever want a FULL unique index on (zoho_user_id) instead of the partial one,
 * run the dedupe below first to ensure only one active row per user remains:
 *
 * WITH ranked AS (
 *   SELECT id, zoho_user_id,
 *          row_number() OVER (
 *            PARTITION BY zoho_user_id
 *            ORDER BY updated_at DESC NULLS LAST, created_at DESC
 *          ) AS rn
 *   FROM zoho_tokens
 *   WHERE revoked IS NOT TRUE
 * )
 * UPDATE zoho_tokens z
 * SET revoked = TRUE, updated_at = now()
 * FROM ranked r
 * WHERE z.id = r.id
 *   AND r.rn > 1;
 *
 * Then create a global unique index:
 *   CREATE UNIQUE INDEX uq_zoho_tokens_zoho_user_idx ON zoho_tokens (zoho_user_id);
 *
 * NOTE: You do NOT need to do this for your current setup—your partial unique works fine
 *       as long as your UPSERT uses "ON CONFLICT ON CONSTRAINT uniq_zoho_tokens_active_user".
 */
