import express, { Request, Response } from 'express';
import { exchangeCodeForToken, saveZohoTokens } from '../services/zoho';

const router = express.Router();

const {
    ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com',
    ZOHO_API_BASE = 'https://www.zohoapis.com',
    ZOHO_CLIENT_ID = '',
    ZOHO_CLIENT_SECRET = '',
    ZOHO_REDIRECT_URI = 'https://timeoff.timesharehelpcenter.com/api/zoho/callback',
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
    APP_BASE_URL = 'https://timeoff.timesharehelpcenter.com',
} = process.env;

/** Simple logger */
function logZoho(label: string, data: unknown) {
    try {
        // eslint-disable-next-line no-console
        console.error(
            `[ZOHO] ${label}:`,
            typeof data === 'string' ? data : JSON.stringify(data)
        );
    } catch {
        // eslint-disable-next-line no-console
        console.error(`[ZOHO] ${label} (unstringifiable)`);
    }
}

/** Build Zoho OAuth authorize URL */
function buildAuthorizeUrl(): string {
    const qp = new URLSearchParams({
        response_type: 'code',
        client_id: ZOHO_CLIENT_ID,
        scope: ZOHO_SCOPES,
        redirect_uri: ZOHO_REDIRECT_URI,
        access_type: 'offline',
        prompt: 'consent',
    });
    return `${ZOHO_ACCOUNTS_BASE}/oauth/v2/auth?${qp.toString()}`;
}

/** Fetch current Zoho user via CRM API (CurrentUser) */
async function fetchCurrentZohoUser(accessToken: string, apiBase: string = ZOHO_API_BASE) {
    const base = apiBase.replace(/\/+$/, '');
    const url = `${base}/crm/v2/users?type=CurrentUser`;

    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`fetchCurrentZohoUser ${res.status}: ${text || res.statusText}`);
    }
    const data = (await res.json()) as any;
    const user = Array.isArray(data.users) && data.users.length > 0 ? data.users[0] : null;
    if (!user) throw new Error('fetchCurrentZohoUser: no user payload');

    return {
        zohoUserId: String(user.id),
        email: user.email || null,
        fullName: user.full_name || null,
    };
}

/** 1) Start OAuth */
router.get('/start', (_req: Request, res: Response) => {
    try {
        return res.redirect(buildAuthorizeUrl());
    } catch (e: any) {
        logZoho('start:error', { message: e?.message, stack: e?.stack });
        return res.status(500).json({ ok: false, error: e?.message || 'Failed to create Zoho authorize URL' });
    }
});

/** 2) OAuth callback */
router.get('/callback', async (req: Request, res: Response) => {
    const { code, error, error_description } = req.query as Record<string, string | undefined>;

    if (error) {
        logZoho('callback:provider_error', { error, error_description });
        return res.status(400).send('Callback error');
    }
    if (!code) {
        logZoho('callback:missing_code', req.query);
        return res.status(400).send('Callback error');
    }

    try {
        // Exchange code → tokens (service expects only the code)
        const tokens = await exchangeCodeForToken(code);
        // Expected minimal shape:
        // { access_token: string; expires_in: number; refresh_token?: string; token_type?: string; scope?: string; api_domain?: string }

        if (!tokens?.access_token) {
            logZoho('callback:token_exchange_missing_access', tokens as any);
            return res.status(400).send('Callback error');
        }

        // Prefer api_domain if present; otherwise use ZOHO_API_BASE
        const apiDomain = (tokens as any)?.api_domain as string | undefined;
        const apiBase = apiDomain && apiDomain.startsWith('http') ? apiDomain : ZOHO_API_BASE;

        // Identify current user
        const me = await fetchCurrentZohoUser(tokens.access_token, apiBase);
        if (!me?.zohoUserId) {
            logZoho('callback:missing_user_id', me as any);
            return res.status(400).send('Callback error');
        }

        // Compute expiry
        const expiresAt = new Date(Date.now() + (Number(tokens.expires_in ?? 3600) * 1000));

        // Persist tokens — only fields allowed by SaveTokensInput
        await saveZohoTokens({
            zohoUserId: String(me.zohoUserId),
            accessToken: tokens.access_token,
            refreshToken: (tokens as any)?.refresh_token ?? null,
            tokenType: tokens.token_type ?? 'Bearer',
            expiresAt,
        });

        // Optional cookie to let UI know we’re connected
        res.cookie('zoho_connected', '1', {
            httpOnly: true,
            sameSite: 'lax',
            secure: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/',
        });

        // Clean redirect (no params) to avoid loops
        return res.redirect(APP_BASE_URL);
    } catch (e: any) {
        // e.g., invalid_code, redirect URI mismatch, wrong region, bad client creds, DB schema
        logZoho('callback:exception', { message: e?.message, stack: e?.stack });
        return res.status(400).send('Callback error');
    }
});

export default router;
