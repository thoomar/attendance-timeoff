// server/src/routes/zoho.ts
import express, { Request, Response } from 'express';
import {
    getZohoAuthorizeUrl,
    exchangeCodeForTokens,
    getCurrentZohoUserId,
    upsertZohoTokens,
    selectTokensExpiringWithin,
    refreshAccessToken,
    updateAccessTokenById,
} from '../services/zoho';

const router = express.Router();

const {
    ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
    CRON_SECRET,
    // Where to send the user after a successful link
    APP_BASE_URL = 'https://timeoff.timesharehelpcenter.com',
} = process.env;

/**
 * Utility: safe log helper so we always know where errors came from.
 */
function logZoho(label: string, data: unknown) {
    try {
        // eslint-disable-next-line no-console
        console.error(`[ZOHO] ${label}:`, typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
        // eslint-disable-next-line no-console
        console.error(`[ZOHO] ${label} (unstringifiable)`);
    }
}

/**
 * 1) Start OAuth: redirect user to Zoho consent screen
 * GET /api/zoho/start
 */
router.get('/start', (_req: Request, res: Response) => {
    try {
        const url = getZohoAuthorizeUrl(ZOHO_SCOPES);
        return res.redirect(url);
    } catch (e: any) {
        logZoho('start:error', { message: e?.message, stack: e?.stack });
        return res.status(500).json({ ok: false, error: e?.message || 'Failed to create Zoho authorize URL' });
    }
});

/**
 * 2) OAuth callback: exchange code -> tokens, get current user id, upsert tokens.
 *    On success, redirect to app root (no query params) to avoid loops.
 * GET /api/zoho/callback
 */
router.get('/callback', async (req: Request, res: Response) => {
    const { code, error, error_description } = req.query as Record<string, string | undefined>;

    // If Zoho sent back an error
    if (error) {
        logZoho('callback:provider_error', { error, error_description });
        return res.status(400).send('Callback error');
    }
    if (!code) {
        logZoho('callback:missing_code', req.query);
        return res.status(400).send('Callback error');
    }

    try {
        // 1) Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code); // { access_token, refresh_token, expires_in, scope, api_domain, token_type }
        if (!tokens?.access_token) {
            logZoho('callback:token_exchange_missing_access', tokens);
            return res.status(400).send('Callback error');
        }

        // 2) Get current Zoho user identity using the fresh access token
        const me = await getCurrentZohoUserId(tokens.access_token);
        // Expecting something like { zohoUserId, email, fullName } from your service
        if (!me?.zohoUserId) {
            logZoho('callback:missing_user_id', me);
            return res.status(400).send('Callback error');
        }

        // 3) Upsert tokens keyed by zohoUserId (handles duplicate key gracefully)
        const expiresAt = new Date(Date.now() + (Number(tokens.expires_in ?? 3600) * 1000));
        await upsertZohoTokens({
            zohoUserId: String(me.zohoUserId),
            email: me.email ?? null,
            fullName: me.fullName ?? null,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            scope: tokens.scope ?? ZOHO_SCOPES,
            tokenType: tokens.token_type ?? 'Bearer',
            apiDomain: tokens.api_domain ?? null,
            expiresAt,
            raw: tokens as unknown as Record<string, unknown>, // keep raw for debugging if your table supports jsonb
        });

        // 4) Optional cookie to indicate connection (httponly=true)
        res.cookie('zoho_connected', '1', {
            httpOnly: true,
            sameSite: 'lax',
            secure: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/',
        });

        // 5) Redirect to app root — NO query params to avoid redirect loops
        return res.redirect(APP_BASE_URL);
    } catch (e: any) {
        // Common causes:
        // - invalid_client / bad client id/secret or wrong Zoho region endpoints
        // - invalid_code (single use code already used / expired)
        // - redirect URI mismatch (must match EXACTLY in Zoho settings)
        // - DB upsert schema mismatch / unique constraint errors
        logZoho('callback:exception', { message: e?.message, stack: e?.stack });
        return res.status(400).send('Callback error');
    }
});

/**
 * 3) Cron refresh tokens within a window (minutes)
 *    GET /api/zoho/cron/refresh?secret=...&windowMins=60
 */
router.get('/cron/refresh', async (req: Request, res: Response) => {
    try {
        const { secret, windowMins = '60' } = req.query as Record<string, string | undefined>;
        if (!CRON_SECRET || secret !== CRON_SECRET) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }

        const window = Math.max(15, Number(windowMins) || 60); // min 15 mins safety
        const expiring = await selectTokensExpiringWithin(window);
        let refreshed = 0;
        const items: Array<{ id: string; ok: boolean; error?: string }> = [];

        for (const t of expiring) {
            try {
                const newAccess = await refreshAccessToken(t.refresh_token);
                if (newAccess?.access_token) {
                    const newExpiresAt = new Date(Date.now() + (Number(newAccess.expires_in ?? 3600) * 1000));
                    await updateAccessTokenById(t.id, {
                        accessToken: newAccess.access_token,
                        expiresAt: newExpiresAt,
                        apiDomain: newAccess.api_domain ?? t.api_domain,
                        tokenType: newAccess.token_type ?? t.token_type,
                        scope: newAccess.scope ?? t.scope,
                    });
                    refreshed++;
                    items.push({ id: t.id, ok: true });
                } else {
                    items.push({ id: t.id, ok: false, error: 'No access_token in refresh response' });
                }
            } catch (e: any) {
                items.push({ id: t.id, ok: false, error: e?.message || 'refresh error' });
                logZoho('cron:refresh_item_error', { id: t.id, message: e?.message, stack: e?.stack });
            }
        }

        return res.json({
            ok: true,
            windowMins: window,
            checked: expiring.length,
            refreshed,
            errors: items.filter(i => !i.ok).length,
            items,
        });
    } catch (e: any) {
        logZoho('cron:refresh_exception', { message: e?.message, stack: e?.stack });
        return res.status(500).json({ ok: false, error: e?.message || 'cron refresh failed' });
    }
});

export default router;
