import 'server-only';
import { APP_URL } from '@/lib/constants';
import { getEnvVariable } from '@/lib/dotenvx';

/**
 * Agentcard ("virtual cards for agents") OAuth 2.1 + PKCE + MCP integration.
 *
 * This module lets Kilo issue and manage Agentcard virtual cards ON BEHALF OF
 * its end users. Each Kilo user authenticates once via "Connect with Agentcard"
 * (OAuth 2.1 + PKCE); we then call the Agentcard MCP server with that user's
 * bearer token. Cards are isolated per (client, user).
 *
 * Endpoints are pinned to the production defaults below but are always
 * re-confirmed against the server's discovery document at runtime
 * (see `oauth.ts#getAuthServerMetadata`).
 */

/** Authorization-server origin (issuer). Override with AGENTCARD_BASE_URL. */
export const AGENTCARD_BASE_URL = (
  getEnvVariable('AGENTCARD_BASE_URL') || 'https://mcp.agentcard.sh'
).replace(/\/$/, '');

/**
 * The protected resource (the MCP server). This value is the MANDATORY
 * `resource` parameter on BOTH /authorize and /token, and is the URL we POST
 * MCP JSON-RPC to. Override with AGENTCARD_MCP_URL.
 */
export const AGENTCARD_MCP_URL =
  getEnvVariable('AGENTCARD_MCP_URL') || 'https://mcp.agentcard.sh/mcp';

/** Pinned discovery defaults (verified against discovery before use). */
export const AGENTCARD_DEFAULT_ENDPOINTS = {
  issuer: `${AGENTCARD_BASE_URL}/`,
  registration_endpoint: `${AGENTCARD_BASE_URL}/register`,
  authorization_endpoint: `${AGENTCARD_BASE_URL}/authorize`,
  token_endpoint: `${AGENTCARD_BASE_URL}/token`,
  revocation_endpoint: `${AGENTCARD_BASE_URL}/revoke`,
} as const;

/**
 * Public base URL of THIS app, used to build the OAuth redirect URI. Must be
 * publicly reachable (use a tunnel for local dev) and must match the
 * `redirect_uris` registered for the client EXACTLY. Defaults to APP_URL.
 */
export const AGENTCARD_PUBLIC_BASE_URL = (
  getEnvVariable('AGENTCARD_PUBLIC_BASE_URL') || APP_URL
).replace(/\/$/, '');

/** redirect_uri registered with the client and used at /authorize + /token. */
export const AGENTCARD_REDIRECT_URI = `${AGENTCARD_PUBLIC_BASE_URL}/api/agentcard/callback`;

/**
 * Part 1 client identity.
 * - Public client: leave both unset and we self-register via DCR (no secret).
 * - Pinned public client: set AGENTCARD_OAUTH_CLIENT_ID only.
 * - Confidential client: set both AGENTCARD_OAUTH_CLIENT_ID and
 *   AGENTCARD_OAUTH_CLIENT_SECRET (server-side only — minted via the org
 *   endpoint, shown once).
 */
export const AGENTCARD_OAUTH_CLIENT_ID = getEnvVariable('AGENTCARD_OAUTH_CLIENT_ID') || null;
export const AGENTCARD_OAUTH_CLIENT_SECRET =
  getEnvVariable('AGENTCARD_OAUTH_CLIENT_SECRET') || null;

/** Whether this client authenticates to the token endpoint with a secret. */
export const AGENTCARD_IS_CONFIDENTIAL = AGENTCARD_OAUTH_CLIENT_SECRET !== null;

/** Human-facing client name used during Dynamic Client Registration. */
export const AGENTCARD_CLIENT_NAME = getEnvVariable('AGENTCARD_CLIENT_NAME') || 'Kilo';

/**
 * base64-encoded 32-byte key used to encrypt Agentcard tokens at rest in
 * Redis (AES-256-GCM via `@kilocode/encryption`). Required when the
 * integration is enabled.
 */
export const AGENTCARD_TOKEN_ENCRYPTION_KEY =
  getEnvVariable('AGENTCARD_TOKEN_ENCRYPTION_KEY') || null;

/**
 * The integration is considered enabled when an encryption key is configured.
 * (Client id/secret are optional because public clients self-register.)
 */
export function isAgentcardEnabled(): boolean {
  return AGENTCARD_TOKEN_ENCRYPTION_KEY !== null;
}
