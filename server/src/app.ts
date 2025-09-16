import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import routes from './routes';

const app = express();

/**
 * Core middleware
 */
app.set('trust proxy', 1);
app.use(cors()); // loosen if you need stricter origins
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

/**
 * Root ping (non-API)
 */
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'attendance-tracker-api', mount: '/api' });
});

/**
 * Mount all feature routes under /api
 * (health is available at /api/health)
 */
app.use('/api', routes);

export default app;
