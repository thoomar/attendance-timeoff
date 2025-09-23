import type { Request, Response, NextFunction } from 'express';
import { generators, Issuer, Client } from 'openid-client';

const {
    ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID,
    ENTRA_CLIENT_SECRET,
    ENTRA_REDIRECT_URI,
    SESSION_SECRET, // only used to sanity-check presence
    BASE_URL = process.env.APP_BASE_URL || 'https://timeoff.timesharehelpcenter.com',
} = process.env as Record<string, string | undefined>;

if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET || !ENTRA_REDIRECT_URI || !SESSION_SECRET) {
    throw new Error('Missing required env for Entra auth (TENANT/CLIENT/SECRET/REDIRECT/SESSION_SECRET).');
}

let _client: Client | null = null;
async function getClient(): Promise<Client> {
    if (_client) return _client;
    const issuer = await Issuer.discover(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`);
    _client = new issuer.Client({
        client_id: ENTRA_CLIENT_ID,
        client_secret: ENTRA_CLIENT_SECRET,
        redirect_uris: [ENTRA_REDIRECT_URI],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
    });
    return _client;
}

export async function login(_req: Request, res: Response) {
    const client = await getClient();
    const state = generators.state();
    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);

    _req.session.oidc = { state, code_verifier };

    const url = client.authorizationUrl({
        scope: 'openid profile email offline_access',
        response_mode: 'query',
        state,
        code_challenge,
        code_challenge_method: 'S256',
    });
    return res.redirect(url);
}

export async function callback(req: Request, res: Response, next: NextFunction) {
    try {
        const client = await getClient();
        const { state, code_verifier } = req.session.oidc ?? {};
        if (!state || !code_verifier) return res.status(400).send('Invalid session. Start again.');

        const params = client.callbackParams(req);
        if (!params.state || params.state !== state) return res.status(400).send('State mismatch');

        const tokenSet = await client.callback(ENTRA_REDIRECT_URI!, params, { state, code_verifier });
        const userinfo = await client.userinfo(tokenSet);

        const email =
            (userinfo.email as string | undefined) ??
            (userinfo.preferred_username as string | undefined) ??
            (userinfo['upn'] as string | undefined);

        if (!email) return res.status(403).send('No email claim on account.');

        const allowed = String(process.env.ENTRA_ALLOWED_DOMAINS || 'republicfinancialservices.com')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !allowed.includes(domain)) return res.status(403).send('Account not permitted.');

        req.session.user = {
            sub: String(userinfo.sub ?? ''),
            name: String(userinfo.name ?? email),
            email,
            domain,
        };
        delete req.session.oidc;

        return res.redirect(`${BASE_URL}/`);
    } catch (e) {
        return next(e);
    }
}

export function logout(req: Request, res: Response) {
    const postLogoutRedirectUri = `${process.env.BASE_URL || process.env.APP_BASE_URL || 'https://timeoff.timesharehelpcenter.com'}/`;
    const endSessionUrl =
        `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/logout` +
        `?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
    req.session.destroy(() => res.redirect(endSessionUrl));
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (req.session?.user) return next();
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
}

export type SessionUser = { sub: string; name: string; email: string; domain: string };
