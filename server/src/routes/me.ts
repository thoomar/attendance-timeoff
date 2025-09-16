import express, { Request, Response } from 'express';

const router = express.Router();

/**
 * GET /api/me
 * Always 200. Returns { ok: true, user: {...} } or { ok: true, user: null }.
 * - Supports a dev override via x-dev-user header containing JSON.
 * - If some upstream auth populates req.user, we’ll return that too (typed as any).
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    // Dev override header: x-dev-user: {"id": "...", "email":"...", "fullName":"...", "role":"..."}
    const devHeader = req.header('x-dev-user');
    if (devHeader) {
      try {
        const devUser = JSON.parse(devHeader);
        return res.json({ ok: true, user: devUser });
      } catch {
        // ignore parse errors; fall through
      }
    }

    // If some middleware set req.user, surface it (avoid TS type errors with any)
    const maybeUser = (req as any)?.user ?? (req as any)?.session?.user ?? null;

    return res.json({ ok: true, user: maybeUser ?? null });
  } catch (e: any) {
    return res.json({ ok: true, user: null, note: 'soft-error', detail: e?.message });
  }
});

export default router;
