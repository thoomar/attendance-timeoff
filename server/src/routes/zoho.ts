// server/src/routes/zoho.ts
import express, { Request, Response } from 'express';
import { exchangeCodeForToken } from '../services/zoho'; // save happens in services
// ^ routes file does NOT import db

const router = express.Router();

const {
    PUBLIC_APP_URL = 'https://timeoff.timesharehelpcenter.com/time-off',
    ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com',
    ZOHO_API_BASE = 'https://www.zohoapis.com',
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = '',
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
} = process.env;

function safeUrl(url: string): string {
    try { return new URL(url).toString(); } catch { return 'https://timeoff.timesharehelpcenter.com/time-off'; }
}

function buildZohoAuthorizeUrl(scopes: string): string {
    const u = new URL('/oauth/v2/auth', ZOHO_ACCOUNTS_BASE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', ZOHO_CLIENT_ID!);
    u.searchParams.set('redirect_uri', ZOHO_REDIRECT_URI!);
    u.searchParams.set('scope', scopes.trim());
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
}

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
    return resp.json() as Promise<{ access_token: string; refresh_token?: string }>;
}

async function getCurrentZohoUserId(accessToken: string): Promise<string> {
    const u = new URL('/crm/v2/users', ZOHO_API_BASE);
    u.searchParams.set('type', 'CurrentUser');
    const resp = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Zoho whoami failed: ${resp.status} ${txt}`);
    }
    const data = await resp.json();
    const id = data?.users?.[0]?.id;
    if (!id) throw new Error('Could not resolve current Zoho user id');
    return String(id);
}

// 1) Start OAuth
router.get('/start', (_req: Request, res: Response) => {
    try {
        return res.redirect(302, buildZohoAuthorizeUrl(ZOHO_SCOPES));
    } catch (e: any) {
        console.error('[ZOHO][START] Error building auth URL:', e);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

// 2) Callback (exchange + save via services + clean redirect)
router.get('/callback', async (req: Request, res: Response) => {
    const { code, error } = req.query as { code?: string; error?: string };
    if (error) {
        console.error('[ZOHO][CALLBACK] error from Zoho:', error);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
    if (!code) {
        console.error('[ZOHO][CALLBACK] missing code');
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }

    try {
        // Prefer service helper
        const tokens =
            typeof exchangeCodeForToken === 'function'
                ? await exchangeCodeForToken(code)
                : await exchangeCodeWithFetch(code);

        const accessToken = (tokens as any).access_token ?? tokens.access_token;
        if (!accessToken) throw new Error('No access_token from Zoho');

        // Resolve user (services.save handles DB upsert)
        const zohoUserId = await getCurrentZohoUserId(accessToken);

        // Services will save tokens; we only need to redirect the user.
        // (If you want to pass along refreshToken etc., your service can pick up existing token row.)

        return res.redirect(303, safeUrl(PUBLIC_APP_URL)); // no query params to avoid loops
    } catch (e: any) {
        console.error('[ZOHO][CALLBACK] Failed to handle callback:', e?.message || e);
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

export default router;
