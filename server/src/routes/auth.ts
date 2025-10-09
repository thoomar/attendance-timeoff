// src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { Issuer, generators, Client } from 'openid-client';
import { query } from '../db';

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
    try {
        const client = await getClient();

        const state = generators.state();
        const code_verifier = generators.codeVerifier();
        const code_challenge = generators.codeChallenge(code_verifier);

        // Store OIDC state in database (bypasses cookie issues)
        await query(
            `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
             ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = NOW() + INTERVAL '10 minutes'`,
            [`oidc:${state}`, JSON.stringify({ state, code_verifier })]
        );
        console.log('[LOGIN] OIDC state stored in DB:', state.substring(0, 8));

        const authUrl = client.authorizationUrl({
            scope: ENTRA_SCOPES,
            state,
            code_challenge,
            code_challenge_method: 'S256',
        });

        return res.redirect(authUrl);
    } catch (err) {
        console.error('[LOGIN] Error:', err);
        return res.status(500).send('Login initialization failed.');
    }
});

/** OAuth callback – exchange code, store session user, redirect to app */
router.get('/callback', async (req: Request, res: Response) => {
    try {
        const client = await getClient();
        const params = client.callbackParams(req);

        if (!params.state) {
            return res.status(400).send('Missing state parameter.');
        }

        // Look up OIDC state from database
        const { rows } = await query<{ sess: string }>(
            'SELECT sess FROM session WHERE sid = $1 AND expire > NOW()',
            [`oidc:${params.state}`]
        );

        if (!rows.length) {
            console.error('[CALLBACK] OIDC state not found or expired:', params.state.substring(0, 8));
            return res.status(400).send(
                'Session expired or invalid. Please <a href="/api/auth/login">try logging in again</a>.'
            );
        }

        const { state, code_verifier } = JSON.parse(rows[0].sess) as {
            state: string;
            code_verifier: string;
        };

        // Delete the temporary OIDC state
        await query('DELETE FROM session WHERE sid = $1', [`oidc:${params.state}`]);
        console.log('[CALLBACK] Retrieved OIDC state from DB:', state.substring(0, 8));

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

        // Force session save before redirect
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    console.error('[CALLBACK] Session save error:', err);
                    reject(err);
                } else {
                    console.log('[CALLBACK] User session saved:', email);
                    resolve();
                }
            });
        });

        return res.redirect(APP_BASE_URL);
    } catch (err) {
        console.error('[ENTRA CALLBACK ERROR]', err);
        return res.status(500).send('Login failed. Please try again.');
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
