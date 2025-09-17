// server/src/routes/zoho.ts
import express, { Request, Response } from 'express';
import {
    exchangeCodeForToken,
    saveZohoTokens,
} from '../services/zoho';

const router = express.Router();

const {
    // Land users on the time off page by default (you can override in env)
    PUBLIC_APP_URL = 'https://timeoff.timesharehelpcenter.com/time-off',

    // Zoho bases (change for EU/IN if needed)
    ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com',
    ZOHO_API_BASE = 'https://www.zohoapis.com',

    // OAuth app creds + redirect must match your Zoho client config
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = '',

    // Scopes must be enabled in Zoho client
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
} = process.env;

/** Ensure we never create malformed redirects */
function safeUrl(url: string): string {
    try {
        return new URL(url).toString();
    } catch {
        // Fallback to your app shell
        return 'https://timeoff.timesharehelpcenter.com/time-off';
    }
}

/** Build Zoho authorize URL */
function buildZohoAuthorizeUrl(scopes: string): string {
    const u = new URL('/oauth/v2/auth', ZOHO_ACCOUNTS_BASE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', ZOHO_CLIENT_ID!);
    u.searchParams.set('redirect_uri', ZOHO_REDIRECT_URI!);
    u.searchParams.set('scope', scopes.trim());
    // Ensure refresh_token issuance on re-consent
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
}

/** Fallback token exchange (only used if service helper isn’t available) */
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
        token_type?: string;
        expires_in?: number;
        scope?: string;
    }>;
}

/** Resolve the current Zoho user id from the access token */
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

/** -------- 2) OAuth callback: exchange code -> tokens, save, redirect -------- */
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
        // Prefer your service helper; fallback to native fetch if not available
        const tokens =
            typeof exchangeCodeForToken === 'function'
                ? await exchangeCodeForToken(code)
                : await exchangeCodeWithFetch(code);

        // Map only what we need (and what SaveTokensInput accepts)
        const accessToken = (tokens as any).access_token ?? tokens.access_token;
        const refreshToken = (tokens as any).refresh_token ?? tokens.refresh_token;
        const scope = (tokens as any).scope ?? ZOHO_SCOPES;

        // Resolve current Zoho user id
        const zohoUserId = await getCurrentZohoUserId(accessToken);

        // Persist tokens using only known keys
        await saveZohoTokens({
            zohoUserId,
            accessToken,
            refreshToken,
            scope,
            receivedAt: new Date(),
        });

        // Success: clean landing (NO query params to avoid loops)
        return res.redirect(303, safeUrl(PUBLIC_APP_URL));
    } catch (e: any) {
        console.error('[ZOHO][CALLBACK] Failed to handle callback:', e?.message || e);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

export default router;
