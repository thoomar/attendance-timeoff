import express, { Request, Response } from 'express';
import {
    exchangeCodeForToken,
    saveZohoTokens,
    // refreshAccessToken, // Uncomment + wire if you expose cron helpers below
} from '../services/zoho';

const router = express.Router();

const {
    // Where to land users after OAuth completes (no query params to prevent loops)
    PUBLIC_APP_URL = 'https://timeoff.timesharehelpcenter.com',

    // Zoho OAuth / API bases; customize for EU/IN/… as needed
    ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com', // e.g. https://accounts.zoho.eu
    ZOHO_API_BASE = 'https://www.zohoapis.com',       // e.g. https://www.zohoapis.eu

    // OAuth app creds + redirect must match what you registered in Zoho
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = '',

    // Scopes must be enabled in your Zoho client config
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',

    // CRON_SECRET = '', // For cron route if you enable it
} = process.env;

/** Utility: ensure we never create malformed redirects */
function safeUrl(url: string): string {
    try {
        return new URL(url).toString();
    } catch {
        return 'https://timeoff.timesharehelpcenter.com';
    }
}

/** Build Zoho authorize URL */
function buildZohoAuthorizeUrl(scopes: string): string {
    const u = new URL('/oauth/v2/auth', ZOHO_ACCOUNTS_BASE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', ZOHO_CLIENT_ID!);
    u.searchParams.set('redirect_uri', ZOHO_REDIRECT_URI!);
    u.searchParams.set('scope', scopes.trim());
    // Make sure we always get a refresh_token when needed:
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
}

/** Exchange code for tokens using native fetch (fallback if service helper changes) */
async function exchangeCodeWithFetch(code: string) {
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
    return resp.json() as Promise<{
        access_token: string;
        refresh_token?: string;
        token_type: string;
        expires_in: number;
        scope?: string;
    }>;
}

/** Get current Zoho userId using the CRM API */
async function getCurrentZohoUserId(accessToken: string): Promise<string> {
    const u = new URL('/crm/v2/users', ZOHO_API_BASE);
    u.searchParams.set('type', 'CurrentUser');

    const resp = await fetch(u, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Zoho whoami failed: ${resp.status} ${txt}`);
    }

    const data = await resp.json();
    // Expected shape: { users: [{ id: "1234567890", ... }] }
    const id = data?.users?.[0]?.id;
    if (!id) throw new Error('Could not resolve current Zoho user id');
    return String(id);
}

/** -------- 1) Start OAuth: redirect user to Zoho consent screen -------- */
router.get('/start', (req: Request, res: Response) => {
    try {
        const authUrl = buildZohoAuthorizeUrl(ZOHO_SCOPES);
        return res.redirect(302, authUrl);
    } catch (e: any) {
        console.error('[ZOHO][START] Error building auth URL:', e);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

/** -------- 2) OAuth callback: exchange code -> tokens, upsert, redirect -------- */
router.get('/callback', async (req: Request, res: Response) => {
    const { code, error } = req.query as { code?: string; error?: string };

    if (error) {
        console.error('[ZOHO][CALLBACK] error param from Zoho:', error);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
    if (!code) {
        console.error('[ZOHO][CALLBACK] missing code');
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }

    try {
        // Prefer your service helper if present, else fallback to native fetch impl
        const tokens =
            typeof exchangeCodeForToken === 'function'
                ? await exchangeCodeForToken(code)
                : await exchangeCodeWithFetch(code);

        const accessToken = (tokens as any).access_token ?? tokens.access_token;
        const refreshToken = (tokens as any).refresh_token ?? tokens.refresh_token;
        const tokenType = (tokens as any).token_type ?? tokens.token_type;
        const expiresIn = Number((tokens as any).expires_in ?? tokens.expires_in);
        const scope = (tokens as any).scope ?? ZOHO_SCOPES;

        // Resolve current Zoho user id with the fresh access token
        const zohoUserId = await getCurrentZohoUserId(accessToken);

        // Persist tokens using your exported helper
        await saveZohoTokens({
            zohoUserId,
            accessToken,
            refreshToken,
            expiresIn,
            scope,
            receivedAt: new Date(),
        });

        // Success: land on the base app (NO query params)
        return res.redirect(303, safeUrl(PUBLIC_APP_URL));
    } catch (e: any) {
        console.error('[ZOHO][CALLBACK] Failed to handle callback:', e?.message || e);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

/** -------- 3) (Optional) Cron route — re-enable when helpers are available -------- */
// If you later expose helpers like selectTokensExpiringWithin() and updateAccessTokenById(),
// you can bring this back. For now it's commented to avoid build errors.
/*
router.get('/cron/refresh', async (req: Request, res: Response) => {
  try {
    const provided = String(req.query.secret || '');
    if (!CRON_SECRET || provided !== CRON_SECRET) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const windowMins = Math.max(
      5,
      parseInt(String(req.query.windowMins || '60'), 10) || 60
    );

    const items = await selectTokensExpiringWithin(windowMins);
    let refreshed = 0;
    let errors = 0;

    for (const row of items) {
      try {
        const next = await refreshAccessToken(row.refresh_token);
        await updateAccessTokenById(row.id, next.access_token, next.expires_in);
        refreshed++;
      } catch (err) {
        console.error('[ZOHO][CRON] Refresh failed for token id', row.id, err);
        errors++;
      }
    }

    return res.json({
      ok: true,
      windowMins,
      checked: items.length,
      refreshed,
      errors,
      items: items.map((i: any) => ({ id: i.id, zohoUserId: i.zoho_user_id })),
    });
  } catch (e: any) {
    console.error('[ZOHO][CRON] Error:', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
*/

export default router;
