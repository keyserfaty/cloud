import { createHash } from 'node:crypto';
import { generatePkce, pkceChallenge, randomToken } from './crypto';

describe('agentcard/crypto', () => {
  it('derives code_challenge as base64url(sha256(verifier))', () => {
    const verifier = randomToken(32);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceChallenge(verifier)).toBe(expected);
  });

  it('generatePkce produces a matching verifier/challenge pair', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    // base64url(32 bytes) is 43 chars, within RFC 7636's 43–128 range.
    expect(codeVerifier).toHaveLength(43);
    expect(codeChallenge).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
  });

  it('produces unique verifiers', () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
  });
});
