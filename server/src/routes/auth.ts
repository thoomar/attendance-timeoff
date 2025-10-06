// src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { Issuer, generators, Client } from 'openid-client';

const {
    // Prefer ENTRA_* but fall back to AZURE_* if those are set
    ENTRA_TENANT_ID = process.env.AZURE_TENANT_ID,
    ENTRA_CLIENT_ID = process.env.AZURE_CLIENT_ID,
    ENTRA_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET,
    ENTRA_REDIRECT_URI = process.env.AZURE_REDIRECT_URI,

    ENTRA_SCOPES = 'openid profile email offline_access',
    APP_BASE_URL = 'https://timeoff.timesharehelpcenter.com',
} = process.env;

let oidcClient: Client | null = null;

async function getClient(): Promise<Client> {
    if (oidcClient) return oidcClient;

    if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET || !ENTRA_REDIRECT_URI) {
        throw new Error(
            '[AAD OIDC] Missing one or more env vars: ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_REDIRECT_URI',
        );
    }

    const authority = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`;
    const issuer = await Issuer.discover(`${authority}/.well-known/openid-configuration`);

    oidcClient = new issuer.Client({
        client_id: ENTRA_CLIENT_ID,
        client_secret: ENTRA_CLIENT_SECRET,
        redirect_uris: [ENTRA_REDIRECT_URI],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
    });

    return oidcClient;
}

const router = Router();

/** Start login (PKCE) */
router.get('/login', async (req: Request, res: Response) => {
    const client = await getClient();

    const state = generators.state();
    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);

    // Save CSRF + PKCE verifier in the session
    req.session.oidc = { state, code_verifier };

    const authUrl = client.authorizationUrl({
        scope: ENTRA_SCOPES,
        state,
        code_challenge,
        code_challenge_method: 'S256',
    });

    return res.redirect(authUrl);
});

/** OAuth callback – exchange code, store session user, redirect to app */
router.get('/callback/azure', async (req: Request, res: Response) => {
    try {
        const client = await getClient();
        const params = client.callbackParams(req);

        const { state, code_verifier } = (req.session.oidc || {}) as {
            state: string;
            code_verifier: string;
        };

        const tokenSet = await client.callback(ENTRA_REDIRECT_URI!, params, {
            state,
            code_verifier,
        });

        const claims = tokenSet.claims();
        const email =
            (claims.email as string) ||
            (claims.upn as string) ||
            (claims.preferred_username as string) ||
            '';

        const userPayload = {
            id: (claims.oid as string) || (claims.sub as string),
            email,
            fullName: (claims.name as string) || email || 'Unknown',
            role: 'Enrollment Specialist' as const,
        };

        (req.session as any).user = userPayload;
        delete (req.session as any).oidc;

        return res.redirect(APP_BASE_URL);
    } catch (err) {
        console.error('[ENTRA CALLBACK ERROR]', err);
        return res.status(500).send('Login failed.');
    }
});

/** Logout */
router.post('/logout', (req: Request, res: Response) => {
    req.session.destroy(() => {
        res.clearCookie('attn.sid');
        res.redirect(APP_BASE_URL);
    });
});

export default router;
