// src/index.ts
import * as dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import compression from 'compression';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

import { attachSessionUser } from './auth';

import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import timeOffRoutes from './routes/timeOff';
import debugRoutes from './routes/_debug';

const {
    SESSION_SECRET,
    APP_BASE_URL,
    BASE_URL = APP_BASE_URL || 'https://timeoff.timesharehelpcenter.com',

    NODE_ENV = 'production',
    PORT = '4000',

    DATABASE_URL,
    DB_PASSWORD,

    ALLOW_DEV_HEADER,
} = process.env;

if (!SESSION_SECRET) throw new Error('SESSION_SECRET is required');

const IS_PROD = NODE_ENV === 'production';
// Don't set domain - let browser use the request domain (more secure and compatible)
const COOKIE_DOMAIN = undefined;

const PgStore = connectPgSimple(session);
const pgConnString =
    DATABASE_URL ||
    `postgres://app${DB_PASSWORD ? `:${DB_PASSWORD}` : ''}@127.0.0.1:5433/attendance`;

const app = express();

// We are behind nginx → needed so secure cookies work
app.set('trust proxy', 1);

app.use(morgan(IS_PROD ? 'combined' : 'dev'));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(
    cors({
        origin(origin, cb) {
            const allowed = new Set<string>([
                BASE_URL,
                'https://timeoff.timesharehelpcenter.com',
                'http://localhost:5173',
                'http://127.0.0.1:5173',
                'http://localhost:3000',
                'http://127.0.0.1:3000',
            ]);
            if (!origin || allowed.has(origin)) return cb(null, true);
            return cb(new Error(`CORS blocked for origin: ${origin}`));
        },
        credentials: true,
    }),
);

// Sessions (Postgres store)
app.use(
    session({
        name: 'attn.sid',
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        store: new PgStore({
            conString: pgConnString,
            tableName: 'session',
            createTableIfMissing: true,
        }),
        cookie: {
            httpOnly: true,
            // Use Lax for better compatibility (same-site redirects OK)
            sameSite: 'lax',
            secure: true,
            domain: IS_PROD ? COOKIE_DOMAIN : undefined,
            path: '/',
            maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
        },
    }),
);

// (Optional) Dev header for testing without SSO
app.use((req, _res, next) => {
    const allowDevHeader = ALLOW_DEV_HEADER === '1' || !IS_PROD;
    if (allowDevHeader) {
        const h = req.headers['x-dev-user'];
        if (h) {
            try {
                const parsed = typeof h === 'string' ? JSON.parse(h) : undefined;
                if (parsed?.email && parsed?.id) {
                    (req.session as any).user = {
                        id: parsed.id,
                        email: parsed.email,
                        fullName: parsed.fullName || parsed.name || parsed.email,
                        role: parsed.role || 'Employee',
                    };
                }
            } catch {
                // ignore malformed JSON
            }
        }
    }
    next();
});

// Attach req.user from session for downstream routes
app.use(attachSessionUser);

// Health checks
app.get('/healthz', (_req, res) => res.json({ ok: true, status: 'healthy' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/time-off', timeOffRoutes);
app.use('/api/_debug', debugRoutes);

// 404 for unmatched API routes
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    const message = err?.message || 'Internal Server Error';
    if (!IS_PROD) console.error('Unhandled error:', err);
    res.status(status).json({ ok: false, error: message });
});

const port = Number(PORT);
app.listen(port, () => {
    console.log(`API listening on http://localhost:${port} (base: ${BASE_URL})`);
});

export default app;
