// server/src/index.ts

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Force-load iconv-lite encodings so body-parser/raw-body never fails with
// "Cannot find module '../encodings'" in hoisted/monorepo setups.
import 'iconv-lite/encodings';

import zohoRoutes from './routes/zoho';
import timeOffRoutes from './routes/timeOff';
import meRoutes from './routes/me';

dotenv.config();

const app = express();

// CORS
app.use(cors());

// Accept both urlencoded and JSON bodies (more tolerant across proxies/clients)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// (Optional) Debug: log incoming body info for time-off endpoints
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/time-off')) {
    const ct = req.headers['content-type'] || '';
    const size =
      req.body && typeof req.body === 'object'
        ? Buffer.byteLength(JSON.stringify(req.body), 'utf8')
        : 0;
    console.log(`[body] ${req.method} ${req.path} ct="${ct}" size=${size}`);
  }
  next();
});

// Routes
app.use('/api/me', meRoutes);
app.use('/api/zoho', zohoRoutes);
app.use('/api/time-off', timeOffRoutes);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log('Dev user override: set header x-dev-user with JSON {id,email,fullName,role,managerUserId}');
});
