import { AGENTCARD_MCP_URL, AGENTCARD_REDIRECT_URI } from './config';
import {
  __resetMetadataCache,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  expiresAtFromNow,
  isExpired,
  refreshAccessToken,
  registerClient,
} from './oauth';

const DISCOVERY = {
  issuer: 'https://mcp.agentcard.sh/',
  registration_endpoint: 'https://mcp.agentcard.sh/register',
  authorization_endpoint: 'https://mcp.agentcard.sh/authorize',
  token_endpoint: 'https://mcp.agentcard.sh/token',
  revocation_endpoint: 'https://mcp.agentcard.sh/revoke',
  code_challenge_methods_supported: ['S256'],
};

type Recorded = { url: string; init?: RequestInit };

function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify(DISCOVERY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function formOf(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body));
}

beforeEach(() => __resetMetadataCache());

describe('agentcard/oauth', () => {
  it('registers a public client via DCR (no secret)', async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (url === DISCOVERY.registration_endpoint) {
        const body = JSON.parse(String(init?.body));
        expect(body.token_endpoint_auth_method).toBe('none');
        expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
        expect(body.redirect_uris).toEqual([AGENTCARD_REDIRECT_URI]);
        return new Response(JSON.stringify({ client_id: 'public-client-123' }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const { clientId } = await registerClient(fetch);
    expect(clientId).toBe('public-client-123');
    expect(calls.some(c => c.url === DISCOVERY.registration_endpoint)).toBe(true);
  });

  it('builds an /authorize URL with the mandatory resource + S256 PKCE', async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 404 }));
    const url = new URL(
      await buildAuthorizeUrl(
        { clientId: 'cid', codeChallenge: 'challenge', state: 'state123' },
        fetch
      )
    );
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(AGENTCARD_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(AGENTCARD_MCP_URL);
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('exchanges an authorization code with code_verifier + resource (public client, no secret)', async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (url === DISCOVERY.token_endpoint) {
        const form = formOf(init);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('auth-code');
        expect(form.get('code_verifier')).toBe('verifier-xyz');
        expect(form.get('redirect_uri')).toBe(AGENTCARD_REDIRECT_URI);
        expect(form.get('resource')).toBe(AGENTCARD_MCP_URL);
        expect(form.get('client_secret')).toBeNull();
        return new Response(
          JSON.stringify({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            token_type: 'bearer',
            expires_in: 86400,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const token = await exchangeCodeForToken(
      { clientId: 'cid', code: 'auth-code', codeVerifier: 'verifier-xyz' },
      fetch
    );
    expect(token.access_token).toBe('at-1');
    expect(token.refresh_token).toBe('rt-1');
    expect(token.expires_in).toBe(86400);
    expect(calls.some(c => c.url === DISCOVERY.token_endpoint)).toBe(true);
  });

  it('includes client_secret on the code exchange for confidential clients', async () => {
    const { fetch } = mockFetch((url, init) => {
      if (url === DISCOVERY.token_endpoint) {
        expect(formOf(init).get('client_secret')).toBe('shh-secret');
        return new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            token_type: 'bearer',
            expires_in: 10,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    await exchangeCodeForToken(
      { clientId: 'cid', code: 'c', codeVerifier: 'v', clientSecret: 'shh-secret' },
      fetch
    );
  });

  it('refreshes with grant_type=refresh_token + resource and rotates the refresh token', async () => {
    const { fetch } = mockFetch((url, init) => {
      if (url === DISCOVERY.token_endpoint) {
        const form = formOf(init);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('old-rt');
        expect(form.get('resource')).toBe(AGENTCARD_MCP_URL);
        return new Response(
          JSON.stringify({
            access_token: 'at-2',
            refresh_token: 'new-rt',
            token_type: 'bearer',
            expires_in: 86400,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const token = await refreshAccessToken({ clientId: 'cid', refreshToken: 'old-rt' }, fetch);
    expect(token.refresh_token).toBe('new-rt');
    expect(token.refresh_token).not.toBe('old-rt');
  });

  it('sends client_secret on refresh for confidential clients', async () => {
    const { fetch } = mockFetch((url, init) => {
      if (url === DISCOVERY.token_endpoint) {
        expect(formOf(init).get('client_secret')).toBe('conf-secret');
        return new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'b',
            token_type: 'bearer',
            expires_in: 5,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    await refreshAccessToken(
      { clientId: 'cid', refreshToken: 'r', clientSecret: 'conf-secret' },
      fetch
    );
  });

  it('isExpired honours the skew window', () => {
    const now = Date.now();
    const future = expiresAtFromNow(3600, now);
    expect(isExpired(future, 60, now)).toBe(false);
    const soon = expiresAtFromNow(30, now);
    expect(isExpired(soon, 60, now)).toBe(true);
    const past = expiresAtFromNow(-10, now);
    expect(isExpired(past, 60, now)).toBe(true);
  });
});
