import 'server-only';
import { captureException } from '@sentry/nextjs';
import { AGENTCARD_OAUTH_CLIENT_SECRET, AGENTCARD_PUBLIC_BASE_URL } from './config';
import { generatePkce, randomToken } from './crypto';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  expiresAtFromNow,
  getPinnedClientId,
  isExpired,
  refreshAccessToken,
  registerClient,
} from './oauth';
import {
  consumeState,
  getCachedClientId,
  getToken,
  saveState,
  saveToken,
  setCachedClientId,
  type StoredToken,
} from './store';
import {
  createAgentcardMcpClient,
  extractToolPayload,
  getApprovalId,
  McpUnauthorizedError,
  type McpToolResult,
} from './mcp-client';

/**
 * Part 5/6 — runtime glue: client resolution, connect flow, valid-token
 * resolution (refresh on near-expiry / 401) and a single card-tool entry point.
 */

/**
 * Resolve the OAuth client_id: a pinned env client_id, else a cached DCR
 * client_id, else self-register via DCR (public client) and cache it.
 */
export async function resolveClientId(): Promise<string> {
  const pinned = getPinnedClientId();
  if (pinned) return pinned;
  const cached = await getCachedClientId();
  if (cached) return cached;
  const { clientId } = await registerClient();
  await setCachedClientId(clientId);
  return clientId;
}

/** Public "Connect with Agentcard" link for a given Kilo user id. */
export function buildConnectUrl(userId: string): string {
  return `${AGENTCARD_PUBLIC_BASE_URL}/api/agentcard/connect?user=${encodeURIComponent(userId)}`;
}

/**
 * Begin the connect flow: mint PKCE + state, persist them keyed by `state`,
 * and return the /authorize URL to redirect the user to.
 */
export async function beginConnect(userId: string): Promise<string> {
  const clientId = await resolveClientId();
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomToken(32);
  await saveState(state, { userId, codeVerifier, clientId });
  return buildAuthorizeUrl({ clientId, codeChallenge, state });
}

/**
 * Complete the connect flow at /callback: consume the state, exchange the
 * authorization code for tokens, and persist them for the user.
 */
export async function completeConnect(params: {
  code: string;
  state: string;
}): Promise<{ userId: string }> {
  const pending = await consumeState(params.state);
  if (!pending) throw new Error('Unknown or expired Agentcard OAuth state');
  const token = await exchangeCodeForToken({
    clientId: pending.clientId,
    code: params.code,
    codeVerifier: pending.codeVerifier,
  });
  await persistToken(pending.userId, pending.clientId, token);
  return { userId: pending.userId };
}

async function persistToken(
  userId: string,
  clientId: string,
  token: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  }
): Promise<void> {
  const stored: StoredToken = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAtFromNow(token.expires_in),
    clientId,
    tokenType: token.token_type,
    scope: token.scope,
    updatedAt: new Date().toISOString(),
  };
  await saveToken(userId, stored);
}

/** Whether a user has connected their Agentcard account. */
export async function isConnected(userId: string): Promise<boolean> {
  return (await getToken(userId)) !== null;
}

/**
 * Return a valid access token for the user, refreshing proactively when it is
 * expired or within the refresh skew. Persists the rotated refresh token.
 * Returns null if the user has not connected.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const stored = await getToken(userId);
  if (!stored) return null;
  if (!isExpired(stored.expiresAt)) return stored.accessToken;
  return refreshAndPersist(userId, stored);
}

async function refreshAndPersist(userId: string, stored: StoredToken): Promise<string> {
  const refreshed = await refreshAccessToken({
    clientId: stored.clientId,
    refreshToken: stored.refreshToken,
    clientSecret: AGENTCARD_OAUTH_CLIENT_SECRET,
  });
  await persistToken(userId, stored.clientId, refreshed);
  return refreshed.access_token;
}

export type CallCardToolOptions = {
  /** Auto-resolve `approval_required` results via `approve_request`. */
  autoApprove?: boolean;
};

/**
 * Call one Agentcard card tool on behalf of a user. Refreshes the token on a
 * 401 and retries once; optionally resolves an approval gate automatically.
 */
export async function callCardTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  options: CallCardToolOptions = {}
): Promise<McpToolResult> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('User has not connected Agentcard');

  let result: McpToolResult;
  try {
    result = await createAgentcardMcpClient({ accessToken }).callTool(name, args);
  } catch (error) {
    if (error instanceof McpUnauthorizedError) {
      // Force a refresh and retry once with a fresh token.
      const stored = await getToken(userId);
      if (!stored) throw error;
      const fresh = await refreshAndPersist(userId, stored);
      result = await createAgentcardMcpClient({ accessToken: fresh }).callTool(name, args);
    } else {
      throw error;
    }
  }

  if (options.autoApprove) {
    const approvalId = getApprovalId(result);
    if (approvalId) {
      const token = await getValidAccessToken(userId);
      if (token) {
        await createAgentcardMcpClient({ accessToken: token }).callTool('approve_request', {
          approval_id: approvalId,
        });
        // Re-issue the original call now that the request is approved.
        const token2 = await getValidAccessToken(userId);
        if (token2) {
          result = await createAgentcardMcpClient({ accessToken: token2 }).callTool(name, args);
        }
      }
    }
  }

  return result;
}

/** Best-effort disconnect log helper (errors swallowed). */
export function reportAgentcardError(op: string, error: unknown): void {
  captureException(error, { tags: { component: 'agentcard', op } });
}

export { extractToolPayload };
