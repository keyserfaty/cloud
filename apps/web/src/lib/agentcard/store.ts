import 'server-only';
import { encryptWithSymmetricKey, decryptWithSymmetricKey } from '@kilocode/encryption';
import { redisClient } from '@/lib/redis';
import {
  AGENTCARD_CLIENT_ID_REDIS_KEY,
  agentcardStateRedisKey,
  agentcardTokenRedisKey,
} from '@/lib/redis-keys';
import { AGENTCARD_TOKEN_ENCRYPTION_KEY } from './config';

/**
 * Part 4 — per-user persisted token store + short-lived OAuth state store.
 *
 * Tokens are persisted in Redis, encrypted at rest with AES-256-GCM
 * (`@kilocode/encryption`). State (which carries the PKCE `code_verifier`) is
 * stored with a short TTL and consumed exactly once at /callback.
 *
 * A minimal `KvStore` is injectable so this module can be unit-tested without
 * a live Redis; production uses the shared `redisClient`.
 */
export type KvStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const defaultKv: KvStore = redisClient as unknown as KvStore;

/** A user's Agentcard token bundle, as persisted (decrypted form). */
export type StoredToken = {
  accessToken: string;
  refreshToken: string;
  /** absolute expiry ISO timestamp of the access token. */
  expiresAt: string;
  /** the client_id the tokens were issued to. */
  clientId: string;
  tokenType: string;
  scope?: string;
  updatedAt: string;
};

/** Pending OAuth attempt, keyed by `state`. */
export type PendingState = {
  userId: string;
  codeVerifier: string;
  clientId: string;
};

const STATE_TTL_SECONDS = 10 * 60;

function encryptionKey(): string {
  if (!AGENTCARD_TOKEN_ENCRYPTION_KEY) {
    throw new Error('AGENTCARD_TOKEN_ENCRYPTION_KEY is not configured');
  }
  return AGENTCARD_TOKEN_ENCRYPTION_KEY;
}

export async function saveToken(
  userId: string,
  token: StoredToken,
  kv: KvStore = defaultKv
): Promise<void> {
  const encrypted = encryptWithSymmetricKey(JSON.stringify(token), encryptionKey());
  await kv.set(agentcardTokenRedisKey(userId), encrypted);
}

export async function getToken(
  userId: string,
  kv: KvStore = defaultKv
): Promise<StoredToken | null> {
  const raw = await kv.get(agentcardTokenRedisKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(decryptWithSymmetricKey(raw, encryptionKey())) as StoredToken;
  } catch {
    // Corrupt/undecryptable entry: treat as not connected.
    return null;
  }
}

export async function deleteToken(userId: string, kv: KvStore = defaultKv): Promise<void> {
  await kv.del(agentcardTokenRedisKey(userId));
}

/** Persist a pending OAuth attempt (carrying the PKCE verifier) under `state`. */
export async function saveState(
  state: string,
  pending: PendingState,
  kv: KvStore = defaultKv
): Promise<void> {
  await kv.set(agentcardStateRedisKey(state), JSON.stringify(pending), { ex: STATE_TTL_SECONDS });
}

/** Consume (read + delete) a pending OAuth attempt. Single-use. */
export async function consumeState(
  state: string,
  kv: KvStore = defaultKv
): Promise<PendingState | null> {
  const key = agentcardStateRedisKey(state);
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.del(key);
  try {
    return JSON.parse(raw) as PendingState;
  } catch {
    return null;
  }
}

/** Read the cached DCR client_id, if one has been registered. */
export async function getCachedClientId(kv: KvStore = defaultKv): Promise<string | null> {
  return kv.get(AGENTCARD_CLIENT_ID_REDIS_KEY);
}

/** Cache the DCR client_id so we register only once. */
export async function setCachedClientId(clientId: string, kv: KvStore = defaultKv): Promise<void> {
  await kv.set(AGENTCARD_CLIENT_ID_REDIS_KEY, clientId);
}
