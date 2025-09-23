import 'dotenv/config';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import morgan from 'morgan';
import compression from 'compression';
import session from 'express-session';

import meRoutes from './routes/me';
import timeOffRoutes from './routes/timeOff';
import authRoutes from './routes/auth';
import azureAuthRouter from './auth/azure'; // <-- NEW

const {
    SESSION_SECRET,
    BASE_URL = process.env.APP_BASE_URL || 'https://timeoff.timesharehelpcenter.com',
    NODE_ENV = 'production',
} = process.env;

if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required');
}

const app = express();

/** Behind NGINX so Express knows the original scheme is HTTPS.
 *  (Required for secure cookies to be set/accepted) */
app.set('trust proxy', 1);

app.use(morgan('tiny'));
app.use(compression());
app.use(express.json());
app.use(
    cors({
        origin: [BASE_URL],
        credentials: true,
    })
);

/** Signed, secure session cookie */
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: NODE_ENV === 'production', // requires HTTPS + trust proxy
            maxAge: 1000 * 60 * 60 * 8, // 8 hours
        },
        name: 'attn.sid',
    })
);

/** Minimal auth guard for all protected API routes */
function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (req.session?.user) return next();
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
}

/* -------------------- PUBLIC ENDPOINTS -------------------- */
// Azure OIDC login/callback/logout
app.use('/api/auth/azure', azureAuthRouter);

// Your existing (non-Azure) auth routes, if any
app.use('/api/auth', authRoutes);

// “Who am I?” probe for the frontend; returns 401 if not logged in
app.use('/api/me', meRoutes);

// Healthcheck (kept public)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* -------------------- PROTECTED ENDPOINTS -------------------- */
// Everything below this line requires a valid session
app.use('/api', requireAuth);

// Time Off APIs (now protected)
app.use('/api/time-off', timeOffRoutes);

/* -------------------- BOOT -------------------- */
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
});
