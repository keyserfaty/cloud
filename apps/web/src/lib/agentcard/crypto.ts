import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE + state helpers for the Agentcard OAuth flow.
 *
 * Mirrors the conventions in `@/lib/mcp-gateway/crypto` (base64url, SHA-256)
 * so this integration behaves identically to the host's existing OAuth code.
 */

/** Random URL-safe token, e.g. for `state` or a PKCE `code_verifier`. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** code_challenge = base64url(sha256(code_verifier)). S256 only. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
};

/**
 * Generate a PKCE pair. `code_verifier = base64url(32 random bytes)` (43 chars,
 * within the RFC 7636 43–128 range) and `code_challenge = S256(verifier)`.
 */
export function generatePkce(): PkcePair {
  const codeVerifier = randomToken(32);
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}
