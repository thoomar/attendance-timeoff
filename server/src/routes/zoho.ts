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

// Utility: decode base64url JSON state { r: returnTo, u: userId }

function b64urlToBuffer(s: string) {
  // convert base64url -> base64 + proper padding
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return Buffer.from(s, 'base64');
}

function decodeState(raw?: string): { r?: string; u?: string } {
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// GET /api/zoho/status
// Returns { connected: boolean } for the current user
router.get('/status', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
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
  res.json({ connected });
});

// GET /api/zoho/connect?returnTo=/whatever
// Builds Zoho authorize URL and 302 redirects
router.get('/connect', requireAuth, (req: Request, res: Response) => {
  const returnTo = (req.query.returnTo as string) || '/';
  const userId = (req as any).user.id;

  // Encode state with base64url so it survives round-trip
  const stateObj = { r: returnTo, u: userId };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const url = authorizeUrl(state);
  return res.redirect(302, url);
});

// GET /api/zoho/callback?code=...&state=...
// NOTE: no requireAuth here — we trust userId from the signed/opaque `state`
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    const stateRaw = req.query.state as string | undefined;
    if (!code) return res.status(400).send('Missing code');

    const state = decodeState(stateRaw);
    const userId = (req as any).user?.id || state.u;   // prefer auth if present
    const returnTo = state.r || '/';

    if (!userId) return res.status(401).send('Unauthenticated');

    // Exchange code for tokens
    const token = await exchangeCodeForToken(code);

    // Optional: pull Zoho user info (helpful for audits)
    let zohoUserId: string | null = null;
    try {
      const me = await fetchZohoUser(token.access_token);
      zohoUserId = me?.users?.[0]?.id ?? null;
    } catch {
      // ignore; not critical
    }

    // Persist tokens
    await saveZohoTokens({
      userId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + (token.expires_in - 60) * 1000),
      zohoUserId
    });

    // Back to the app
    return res.redirect(returnTo);
  } catch (err: any) {
    console.error('Zoho callback error:', err?.message || err);
    return res.status(500).send('Callback error');
  }
});

export default router;
