import { Router, Request, Response } from 'express';
import { Issuer, generators, Client } from 'openid-client';

const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_REDIRECT_URI,
    AZURE_SCOPES = 'openid profile email offline_access',
    APP_BASE_URL = '/',
} = process.env;

let oidcClient: Client | null = null;

async function getClient(): Promise<Client> {
    if (oidcClient) return oidcClient;

    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !AZURE_REDIRECT_URI) {
        throw new Error(
            '[AZURE OIDC] Missing one or more env vars: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_REDIRECT_URI'
        );
    }

    // Tenant-specific authority avoids AADSTS700016 “wrong tenant”
    const authority = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`;
    const issuer = await Issuer.discover(`${authority}/.well-known/openid-configuration`);

    oidcClient = new issuer.Client({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        redirect_uris: [AZURE_REDIRECT_URI],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
    });

    return oidcClient;
}

const router = Router();

/**
 * Start login – PKCE (state + code_verifier)
 */
router.get('/login', async (req: Request, res: Response) => {
    const client = await getClient();

    const state = generators.state();
    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);

    // Save CSRF + PKCE verifier in the session
    req.session.oidc = { state, code_verifier };

    const authUrl = client.authorizationUrl({
        scope: AZURE_SCOPES,
        state,
        code_challenge,
        code_challenge_method: 'S256',
    });

    return res.redirect(authUrl);
});

/**
 * OAuth callback – exchange code using stored PKCE verifier, establish session
 */
router.get('/callback', async (req: Request, res: Response) => {
    try {
        const client = await getClient();
        const params = client.callbackParams(req);

        const { state, code_verifier } =
        (req.session.oidc as { state: string; code_verifier: string }) || {};

        const tokenSet = await client.callback(AZURE_REDIRECT_URI!, params, {
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
            // Some orgs expose oid; otherwise fall back to sub
            id: (claims.oid as string) || (claims.sub as string),
            email,
            name: (claims.name as string) || email || 'Unknown',
            provider: 'azure' as const,
        };

        // Your SessionUser type doesn’t have `id`; assign with a safe cast
        (req.session as any).user = userPayload;

        // cleanup one-time artifacts
        delete (req.session as any).oidc;

        return res.redirect(APP_BASE_URL);
    } catch (err) {
        console.error('[AZURE CALLBACK ERROR]', err);
        return res.status(500).send('Login failed.');
    }
});

/**
 * Logout – destroy local session
 */
router.post('/logout', (req: Request, res: Response) => {
    req.session.destroy(() => {
        res.clearCookie('attn.sid');
        res.redirect(APP_BASE_URL);
    });
});

export default router;
