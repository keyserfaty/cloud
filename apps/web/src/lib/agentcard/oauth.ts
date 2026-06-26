import 'server-only';
import {
  AGENTCARD_BASE_URL,
  AGENTCARD_CLIENT_NAME,
  AGENTCARD_DEFAULT_ENDPOINTS,
  AGENTCARD_MCP_URL,
  AGENTCARD_OAUTH_CLIENT_ID,
  AGENTCARD_OAUTH_CLIENT_SECRET,
  AGENTCARD_REDIRECT_URI,
} from './config';

/**
 * Part 1 (client) + Part 2 (per-user OAuth 2.1 + PKCE) for Agentcard.
 *
 * Pure module: no DB/Redis imports so it can be unit-tested offline. A custom
 * `fetch` can be injected for tests; production uses the global `fetch`.
 *
 * The `resource` parameter (= the MCP server URL) is MANDATORY on BOTH
 * /authorize and /token — it is included on every request below.
 */

export type AuthServerMetadata = {
  issuer: string;
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** seconds until the access token expires (Agentcard returns 86400). */
  expires_in: number;
  scope?: string;
};

type FetchImpl = typeof fetch;

const DISCOVERY_PATH = '/.well-known/oauth-authorization-server';

let cachedMetadata: AuthServerMetadata | null = null;

/**
 * Fetch (and cache) the authorization-server metadata. Endpoints can move, so
 * we always prefer the discovered values; on any failure we fall back to the
 * pinned production defaults so the integration degrades gracefully.
 */
export async function getAuthServerMetadata(
  fetchImpl: FetchImpl = fetch
): Promise<AuthServerMetadata> {
  if (cachedMetadata) return cachedMetadata;
  try {
    const response = await fetchImpl(`${AGENTCARD_BASE_URL}${DISCOVERY_PATH}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const body = (await response.json()) as Partial<AuthServerMetadata>;
      cachedMetadata = {
        issuer: body.issuer ?? AGENTCARD_DEFAULT_ENDPOINTS.issuer,
        registration_endpoint:
          body.registration_endpoint ?? AGENTCARD_DEFAULT_ENDPOINTS.registration_endpoint,
        authorization_endpoint:
          body.authorization_endpoint ?? AGENTCARD_DEFAULT_ENDPOINTS.authorization_endpoint,
        token_endpoint: body.token_endpoint ?? AGENTCARD_DEFAULT_ENDPOINTS.token_endpoint,
        revocation_endpoint:
          body.revocation_endpoint ?? AGENTCARD_DEFAULT_ENDPOINTS.revocation_endpoint,
        code_challenge_methods_supported: body.code_challenge_methods_supported ?? ['S256'],
      };
      return cachedMetadata;
    }
  } catch {
    // fall through to pinned defaults
  }
  cachedMetadata = {
    ...AGENTCARD_DEFAULT_ENDPOINTS,
    code_challenge_methods_supported: ['S256'],
  };
  return cachedMetadata;
}

/** Reset the discovery cache (tests only). */
export function __resetMetadataCache(): void {
  cachedMetadata = null;
}

/**
 * Part 1a — Dynamic Client Registration (public client, no secret).
 * Registers a public client whose redirect URI is `<public-base>/api/agentcard/callback`.
 * Returns the issued `client_id` (there is NO client secret for public clients).
 */
export async function registerClient(fetchImpl: FetchImpl = fetch): Promise<{ clientId: string }> {
  const metadata = await getAuthServerMetadata(fetchImpl);
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: AGENTCARD_CLIENT_NAME,
      redirect_uris: [AGENTCARD_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!response.ok) {
    throw new Error(`Agentcard client registration failed: ${response.status}`);
  }
  const body = (await response.json()) as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
    throw new Error('Agentcard client registration returned no client_id');
  }
  return { clientId: body.client_id };
}

/**
 * Build the /authorize URL for the "Connect with Agentcard" redirect.
 * Always includes the mandatory `resource` param and S256 PKCE challenge.
 */
export async function buildAuthorizeUrl(
  params: { clientId: string; codeChallenge: string; state: string },
  fetchImpl: FetchImpl = fetch
): Promise<string> {
  const metadata = await getAuthServerMetadata(fetchImpl);
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', AGENTCARD_REDIRECT_URI);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', AGENTCARD_MCP_URL);
  url.searchParams.set('state', params.state);
  return url.toString();
}

async function postToken(body: URLSearchParams, fetchImpl: FetchImpl): Promise<TokenResponse> {
  const metadata = await getAuthServerMetadata(fetchImpl);
  const response = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!response.ok) {
    // Never log the body — it may carry token material / error detail.
    throw new Error(`Agentcard token request failed: ${response.status}`);
  }
  const json = (await response.json()) as Partial<TokenResponse>;
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') {
    throw new Error('Agentcard token response missing access_token/refresh_token');
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? 'bearer',
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : 86_400,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

/**
 * Part 2 — exchange an authorization code for tokens (authorization_code grant).
 * Sends `resource` and, for confidential clients, `client_secret`. PKCE
 * `code_verifier` is always sent.
 */
export async function exchangeCodeForToken(
  params: { clientId: string; code: string; codeVerifier: string; clientSecret?: string | null },
  fetchImpl: FetchImpl = fetch
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: AGENTCARD_REDIRECT_URI,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
    resource: AGENTCARD_MCP_URL,
  });
  const secret = params.clientSecret ?? AGENTCARD_OAUTH_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);
  return postToken(body, fetchImpl);
}

/**
 * Refresh an access token. Refresh ROTATES the refresh token — callers MUST
 * persist the returned `refresh_token`. Confidential clients must also send the
 * secret here (not just on the code exchange).
 */
export async function refreshAccessToken(
  params: { clientId: string; refreshToken: string; clientSecret?: string | null },
  fetchImpl: FetchImpl = fetch
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    resource: AGENTCARD_MCP_URL,
  });
  const secret = params.clientSecret ?? AGENTCARD_OAUTH_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);
  return postToken(body, fetchImpl);
}

/** Best-effort token revocation (used on disconnect). */
export async function revokeToken(
  params: { clientId: string; token: string; clientSecret?: string | null },
  fetchImpl: FetchImpl = fetch
): Promise<boolean> {
  const metadata = await getAuthServerMetadata(fetchImpl);
  if (!metadata.revocation_endpoint) return false;
  const body = new URLSearchParams({ token: params.token, client_id: params.clientId });
  const secret = params.clientSecret ?? AGENTCARD_OAUTH_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);
  try {
    const response = await fetchImpl(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Convert an `expires_in` (seconds) into an absolute expiry ISO timestamp. */
export function expiresAtFromNow(expiresIn: number, now = Date.now()): string {
  return new Date(now + expiresIn * 1000).toISOString();
}

/**
 * Whether a token at `expiresAtIso` is expired or within `skewSeconds` of it.
 * Default 60s skew so we refresh proactively before a call fails.
 */
export function isExpired(expiresAtIso: string, skewSeconds = 60, now = Date.now()): boolean {
  return new Date(expiresAtIso).getTime() - skewSeconds * 1000 <= now;
}

/**
 * Resolve the active client id: a pinned env client id, else `null`
 * (callers fall back to DCR via `registerClient`).
 */
export function getPinnedClientId(): string | null {
  return AGENTCARD_OAUTH_CLIENT_ID;
}
