import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import compression from 'compression';
import session from 'express-session';

import meRoutes from './routes/me';
import timeOffRoutes from './routes/timeOff';
import authRoutes from './routes/auth';

const {
    SESSION_SECRET,
    BASE_URL = process.env.APP_BASE_URL || 'https://timeoff.timesharehelpcenter.com',
    NODE_ENV = 'production',
} = process.env;

if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required');
}

const app = express();
app.set('trust proxy', 1);

app.use(morgan('tiny'));
app.use(compression());
app.use(express.json());
app.use(cors({
    origin: [BASE_URL],
    credentials: true,
}));

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: NODE_ENV === 'production',
            maxAge: 1000 * 60 * 60 * 8, // 8 hours
        },
        name: 'attn.sid',
    })
);

// routes
app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/time-off', timeOffRoutes);

// health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
});
