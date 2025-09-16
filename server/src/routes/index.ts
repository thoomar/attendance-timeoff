import express, { Request, Response, NextFunction } from 'express';
import timeOffRouter from './timeOff';
import zohoRouter from './zoho';

const router = express.Router();

/**
 * Lightweight health & metadata
 * Mounted under /api/health by the app
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/**
 * Root index for the API namespace
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'attendance-tracker-api',
    routes: ['/health', '/time-off/*', '/zoho/*'],
  });
});

/**
 * Mount feature routers
 */
router.use('/time-off', timeOffRouter);
router.use('/zoho', zohoRouter);

/**
 * 404 for any /api route that wasn’t matched above
 */
router.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: req.path });
});

/**
 * Basic error handler so route-level throws return JSON
 */
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({
    ok: false,
    error: err?.message || String(err),
  });
});

export default router;
