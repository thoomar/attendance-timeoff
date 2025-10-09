// src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { Issuer, generators, Client } from 'openid-client';
import { query } from '../db';
import { signToken } from '../auth/jwt';

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
        const oidcData = JSON.stringify({ state, code_verifier });
        await query(
            `INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, NOW() + INTERVAL '10 minutes')
             ON CONFLICT (sid) DO UPDATE SET sess = $2::json, expire = NOW() + INTERVAL '10 minutes'`,
            [`oidc:${state}`, oidcData]
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
        const { rows } = await query<{ sess: any }>(
            'SELECT sess FROM session WHERE sid = $1 AND expire > NOW()',
            [`oidc:${params.state}`]
        );

        if (!rows.length) {
            console.error('[CALLBACK] OIDC state not found or expired:', params.state.substring(0, 8));
            return res.status(400).send(
                'Session expired or invalid. Please <a href="/api/auth/login">try logging in again</a>.'
            );
        }

        // Parse sess - might be already an object or a string
        const sessData = rows[0].sess;
        const { state, code_verifier } = typeof sessData === 'string' 
            ? JSON.parse(sessData) 
            : sessData;

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

        // Look up user in database to get their actual role
        const userLookup = await query<{ id: string; role: string; full_name: string; manager_user_id: string | null }>(
            'SELECT id, role, full_name, manager_user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
            [email]
        );

        let userPayload;
        if (userLookup.rows.length > 0) {
            // User exists - use their actual role from database
            const dbUser = userLookup.rows[0];
            userPayload = {
                id: dbUser.id,
                email,
                fullName: dbUser.full_name || (claims.name as string) || email,
                role: dbUser.role as any,
                managerUserId: dbUser.manager_user_id,
            };
            console.log('[CALLBACK] Existing user found with role:', dbUser.role);
        } else {
            // New user - create with default role
            const newId = (claims.oid as string) || (claims.sub as string);
            userPayload = {
                id: newId,
                email,
                fullName: (claims.name as string) || email || 'Unknown',
                role: 'Enrollment Specialist' as const,
                managerUserId: null,
            };
            console.log('[CALLBACK] New user, assigning default role');
        }

        // Generate JWT token (bypasses all cookie issues)
        const token = signToken(userPayload);
        console.log('[CALLBACK] JWT generated for:', email, 'with role:', userPayload.role);
        
        // Redirect with token as query parameter for frontend to capture
        return res.redirect(`${APP_BASE_URL}?token=${token}`);
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
