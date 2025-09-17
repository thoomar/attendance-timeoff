
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import meRoutes from './routes/me';
import timeOffRoutes from './routes/timeOff';
import zohoRouter from './routes/zoho';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/me', meRoutes);
app.use('/api/zoho', zohoRouter);
app.use('/api/time-off', timeOffRoutes);

// health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log('Dev user override: set header x-dev-user with JSON {id,email,fullName,role,managerUserId}');
});
