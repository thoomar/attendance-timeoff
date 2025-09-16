import express, { Request, Response } from 'express';

import { requireAuth } from '../auth';
import { pool } from '../db';
import {
  authorizeUrl,          // builds the Zoho /oauth/v2/auth URL
  exchangeCodeForToken,  // exchanges code -> { access_token, refresh_token, expires_in }
  fetchZohoUser,         // fetches current Zoho user (optional)
  saveZohoTokens         // persists tokens into zoho_tokens
} from '../services/zoho';

const router = express.Router();

/**
 * Decode base64url JSON state of shape { r: returnTo, u: userId }
 * Returns {} on failure.
 */
function decodeState(raw?: string): { r?: string; u?: string } {
  if (!raw) return {};
  try {
    // Node 18+ supports "base64url"
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * GET /api/zoho/status
 * Returns { connected: boolean } for the current authenticated user.
 */
router.get('/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id as string | undefined;
    if (!userId) return res.json({ connected: false });

    const q = `
      SELECT 1
        FROM zoho_tokens
       WHERE user_id = $1
         AND COALESCE(refresh_token, '') <> ''
       LIMIT 1
    `;
    const r = await pool.query(q, [userId]);
    const connected = (r.rowCount ?? 0) > 0;
    return res.json({ connected });
  } catch (e: any) {
    return res.status(500).json({ connected: false, error: e?.message || 'status_error' });
  }
});

/**
 * GET /api/zoho/connect?returnTo=/whatever
 * Builds Zoho authorize URL with a base64url-encoded state and 302 redirects there.
 */
router.get('/connect', requireAuth, (req: Request, res: Response) => {
  try {
    const returnTo = (req.query.returnTo as string) || '/';
    const userId = (req as any).user.id as string;

    const stateObj = { r: returnTo, u: userId };
    const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

    const url = authorizeUrl(state);
    return res.redirect(302, url);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'connect_error' });
  }
});

/**
 * GET /api/zoho/callback?code=...&state=...
 * NOTE: no requireAuth here — user identity comes from signed/opaque `state` (and we also accept an authenticated user if present).
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    const stateRaw = req.query.state as string | undefined;
    if (!code) return res.status(400).send('Missing code');

    const state = decodeState(stateRaw);
    // Prefer req.user if middleware already set it; otherwise fall back to state.u
    const userId = (req as any).user?.id || state.u;
    const returnTo = state.r || '/';
    if (!userId) return res.status(401).send('Unauthenticated');

    // Exchange authorization code for tokens
    const token = await exchangeCodeForToken(code);

    // Try to fetch Zoho user info (optional, but nice for audits)
    let zohoUserId: string | null = null;
    try {
      const me = await fetchZohoUser(token.access_token);
      // Align with whatever shape your fetchZohoUser returns
      zohoUserId = (me?.users?.[0]?.id ?? me?.id ?? null) as string | null;
    } catch {
      // Non-fatal
    }

    // Persist tokens (you can also upsert per user)
    await saveZohoTokens({
      userId: String(userId),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + Math.max(0, (token.expires_in ?? 3600) - 60) * 1000),
      zohoUserId
    });

    // Head back to the app
    return res.redirect(returnTo);
  } catch (err: any) {
    console.error('Zoho callback error:', err?.message || err);
    return res.status(500).send('Callback error');
  }
});

export default router;
