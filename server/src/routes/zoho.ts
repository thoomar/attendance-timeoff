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
    CRON_SECRET = '',
    // Where to land users after OAuth completes (no query params to prevent loops)
    PUBLIC_APP_URL = 'https://timeoff.timesharehelpcenter.com',
} = process.env;

/** Utility to ensure we never create malformed redirects */
function safeUrl(url: string): string {
    try {
        return new URL(url).toString();
    } catch {
        return 'https://timeoff.timesharehelpcenter.com';
    }
}

/** -------- 1) Start OAuth: redirect user to Zoho consent screen -------- */
router.get('/start', (req: Request, res: Response) => {
    try {
        // You can add state if you want CSRF protection; Zoho supports it.
        const authUrl = getZohoAuthorizeUrl(ZOHO_SCOPES);
        return res.redirect(302, authUrl);
    } catch (e: any) {
        console.error('[ZOHO][START] Error building auth URL:', e);
        // Even on error, send users to app shell; front-end can show a toast if needed.
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
        // 1) Exchange auth code for tokens
        const tokens = await exchangeCodeForTokens(code);

        // 2) Fetch the Zoho user id associated to this access token
        const zohoUserId = await getCurrentZohoUserId(tokens.access_token);

        // 3) Persist/Upsert tokens by Zoho user id; ensure scope is saved
        await upsertZohoTokens({
            zohoUserId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token, // may be undefined on re-consent, upsert should handle
            expires_in: tokens.expires_in,
            token_type: tokens.token_type,
            scope: tokens.scope || ZOHO_SCOPES,
            received_at: new Date(),
        });

        // 4) Critical: do NOT append ?zoho=...; just land on the base app route.
        // Use 303 to force a GET on the app shell.
        return res.redirect(303, safeUrl(PUBLIC_APP_URL));
    } catch (e: any) {
        console.error('[ZOHO][CALLBACK] Failed to handle callback:', e?.message || e);
        // Uniformly redirect to app shell; front-end can interpret the hash to show a message.
        return res.redirect(303, safeUrl(PUBLIC_APP_URL) + '#zoho-auth-error');
    }
});

/** -------- 3) Cron: proactively refresh tokens that are near expiry -------- */
router.get('/cron/refresh', async (req: Request, res: Response) => {
    try {
        const provided = String(req.query.secret || '');
        if (!CRON_SECRET || provided !== CRON_SECRET) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }

        // default: look 60 minutes ahead unless overridden via ?windowMins=NN
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
            items: items.map(i => ({ id: i.id, zohoUserId: i.zoho_user_id })),
        });
    } catch (e: any) {
        console.error('[ZOHO][CRON] Error:', e);
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

export default router;
