// src/routes/zoho.ts
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
import { db } from '../db';

const router = express.Router();

const {
  ZOHO_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.ALL AaaServer.profile.Read',
  CRON_SECRET,
  FRONTEND_REDIRECT_SUCCESS,
  FRONTEND_REDIRECT_ERROR,
} = process.env;

type TokenCountsRow = {
  active: string;
  revoked: string;
  soon_expiring: string;
};

const toInt = (s: string | number | null | undefined) =>
  typeof s === 'number' ? s : s ? parseInt(String(s), 10) : 0;

function wantsJson(req: Request): boolean {
  const a = (req.get('accept') || '').toLowerCase();
  return a.includes('application/json') || a.includes('json') || (req.query.format === 'json');
}

function successTarget(req: Request): string {
  // Default to root if not set in env
  return FRONTEND_REDIRECT_SUCCESS || (req.headers?.origin as string) || '/';
}

function errorTarget(req: Request, reason?: string): string {
  const base = FRONTEND_REDIRECT_ERROR || '/?zohoError=1';
  if (!reason) return base;
  // Append a short reason param (avoid long URLs)
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}reason=${encodeURIComponent(reason).slice(0, 80)}`;
}

/** 0) CONNECT helper — some clients call /connect instead of /start */
router.get('/connect', (req: Request, res: Response) => {
  try {
    const url = getZohoAuthorizeUrl(process.env.ZOHO_SCOPES || ZOHO_SCOPES);
    if (wantsJson(req)) return res.json({ ok: true, authUrl: url });
    return res.redirect(url);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: msg });
    return res.status(500).send(msg);
  }
});

/** 1) Start OAuth explicitly (kept for backwards-compat) */
router.get('/start', (_req: Request, res: Response) => {
  try {
    const url = getZohoAuthorizeUrl(process.env.ZOHO_SCOPES || ZOHO_SCOPES);
    return res.redirect(url);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 2) OAuth callback: accept both /callback and /callback/, then redirect (or JSON for XHR) */
router.get(['/callback', '/callback/'], async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code ?? '');
    if (!code) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'Missing ?code' });
      return res.redirect(302, errorTarget(req, 'missing_code'));
    }

    const tokens = await exchangeCodeForTokens(code);
    const zohoUserId = await getCurrentZohoUserId(tokens.accessToken, tokens.apiDomain);

    await upsertZohoTokens({
      zohoUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      apiDomain: tokens.apiDomain,
      tokenType: tokens.tokenType,
      scope: tokens.scope ?? (process.env.ZOHO_SCOPES || ZOHO_SCOPES),
    });

    // Success
    if (!wantsJson(req)) {
      // Important: do NOT append any query params — redirect verbatim.
      return res.redirect(302, successTarget(req));
    }
    return res.json({ ok: true, zohoUserId });

  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!wantsJson(req)) {
      return res.redirect(302, errorTarget(req, 'zoho_callback'));
    }
    return res.status(500).json({ ok: false, error: msg });
  }
});

/** 3) Cron refresh: refresh tokens expiring within a window */
router.get('/cron/refresh', async (req: Request, res: Response) => {
  try {
    if (!CRON_SECRET) return res.status(500).json({ ok: false, error: 'CRON_SECRET not set' });
    const secret = String(req.query.secret ?? '');
    if (secret !== CRON_SECRET) return res.status(403).json({ ok: false, error: 'Invalid secret' });

    const windowMins = Math.max(1, parseInt(String(req.query.windowMins ?? '60'), 10));
    const expiring = await selectTokensExpiringWithin(windowMins);

    let refreshed = 0;
    const items: Array<{ id: string; ok: boolean; skipped?: boolean; error?: string }> = [];

    for (const t of expiring) {
      try {
        if (!t.refresh_token) {
          items.push({ id: t.id, ok: true, skipped: true });
          continue;
        }
        const next = await refreshAccessToken(t.refresh_token, t.api_domain ?? undefined);
        await updateAccessTokenById(t.id, next.accessToken, next.expiresAt);
        refreshed++;
        items.push({ id: t.id, ok: true });
      } catch (err: any) {
        items.push({ id: t.id, ok: false, error: err?.message ?? String(err) });
      }
    }

    return res.json({
      ok: true,
      windowMins,
      checked: expiring.length,
      refreshed,
      errors: items.filter(i => !i.ok && !i.skipped).length,
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 4) Status: counts (active, revoked, soon-expiring in 60m) */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const q = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE revoked IS NOT TRUE) AS active,
        COUNT(*) FILTER (WHERE revoked IS TRUE)     AS revoked,
        COUNT(*) FILTER (
          WHERE revoked IS NOT TRUE
            AND expires_at IS NOT NULL
            AND expires_at < (NOW() + INTERVAL '60 minutes')
        ) AS soon_expiring
      FROM zoho_tokens;
      `
    );

    const row = (q.rows?.[0] || {}) as TokenCountsRow;
    return res.json({
      ok: true,
      counts: {
        active: toInt(row.active),
        revoked: toInt(row.revoked),
        soon_expiring: toInt(row.soon_expiring),
      },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 5) Simple “me” probe via granted token (uses CRM fallback under the hood) */
router.get('/me', async (_req: Request, res: Response) => {
  try {
    const q = await db.query(
      `SELECT access_token, api_domain
         FROM zoho_tokens
        WHERE revoked IS NOT TRUE
        ORDER BY created_at DESC
        LIMIT 1`
    );
    const row = q.rows?.[0];
    if (!row) return res.status(404).json({ ok: false, error: 'No active token' });

    const id = await getCurrentZohoUserId(row.access_token, row.api_domain || undefined);
    return res.json({ ok: true, userId: id });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

export default router;
