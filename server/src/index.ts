// src/index.ts
import express from 'express';
import cors from 'cors';
import type { Request, Response, NextFunction } from 'express';

// Routers
import zohoRouter from './routes/zoho';
import timeOffRouter from './routes/timeOff';

// ---- App setup ----
const app = express();

// Trust reverse proxy (NGINX) so req.ip, HTTPS, etc. are correct
app.set('trust proxy', true);

// CORS (open; lock down if you prefer)
app.use(cors());

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple request logger (concise)
app.use((req, _res, next) => {
  const ct = req.headers['content-type'] ?? '';
  const size = (req.headers['content-length'] ?? '').toString();
  // Match your existing style a bit:
  console.log(`[body] ${req.method} ${req.path} ct="${ct}" size=${size || 0}`);
  next();
});

// ---- Health check ----
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---- Routes ----
app.use('/api/zoho', zohoRouter);
app.use('/api/time-off', timeOffRouter);

// ---- 404 handler ----
app.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

// ---- Error handler ----
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const message = err?.message || String(err);
  console.error('Unhandled error:', message);
  res.status(500).json({ ok: false, error: message });
});

// ---- Server bootstrap ----
const PORT = Number(process.env.PORT || 4000);

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(
    'Dev user override: set header x-dev-user with JSON {id,email,fullName,role,managerUserId}'
  );
});

export default app;
