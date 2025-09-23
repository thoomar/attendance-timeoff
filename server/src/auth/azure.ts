import { Router, Request, Response } from 'express';
import { Issuer, generators, Client } from 'openid-client';

const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_REDIRECT_URI,
    AZURE_SCOPES = 'openid profile email offline_access',
} = process.env;

let oidcClient: Client | null = null;
async function getClient(): Promise<Client> {
    if (oidcClient) return oidcClient;
    const authority = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`;
    const issuer = await Issuer.discover(`${authority}/.well-known/openid-configuration`);
    oidcClient = new issuer.Client({
        client_id: AZURE_CLIENT_ID!,
        client_secret: AZURE_CLIENT_SECRET!,
        redirect_uris: [AZURE_REDIRECT_URI!],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
    });
    return oidcClient;
}

const router = Router();

router.get('/login', async (req: Request, res: Response) => {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidc = { state, nonce };

    const url = client.authorizationUrl({
        scope: AZURE_SCOPES,
        response_type: 'code',
        state,
        nonce,
    });
    res.redirect(url);
});

router.get('/callback', async (req: Request, res: Response) => {
    try {
        const client = await getClient();
        const params = client.callbackParams(req);
        const { state, nonce } = req.session.oidc || {};
        const tokenSet = await client.callback(AZURE_REDIRECT_URI!, params, { state, nonce });
        const claims = tokenSet.claims();

        const email =
            (claims.email as string) ||
            (claims.upn as string) ||
            (claims.preferred_username as string) ||
            '';

        req.session.user = {
            id: (claims.oid as string) || (claims.sub as string),
            email,
            name: (claims.name as string) || email || 'Unknown',
            provider: 'azure',
            raw: claims,
        };
        delete req.session.oidc;

        res.redirect(process.env.APP_BASE_URL || '/');
    } catch (e) {
        console.error('[AZURE CALLBACK]', e);
        res.status(500).send('Login failed');
    }
});

router.post('/logout', (req: Request, res: Response) => {
    const base = process.env.APP_BASE_URL || '/';
    req.session.destroy(() => {
        res.clearCookie('sid');
        res.redirect(base);
    });
});

export default router;
