import 'express-session';
import type { SessionUser } from '../auth/entra';

declare module 'express-session' {
    interface SessionData {
        user?: SessionUser;
        oidc?: { state: string; code_verifier: string };
    }
}
