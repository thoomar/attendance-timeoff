// src/types/session.d.ts
import 'express-session';
import type { SessionUser } from '../auth';

declare module 'express-session' {
    interface SessionData {
        user?: SessionUser;
        oidc?: { state: string; code_verifier: string };
    }
}

declare global {
    namespace Express {
        interface Request {
            user: SessionUser;
        }
    }
}
