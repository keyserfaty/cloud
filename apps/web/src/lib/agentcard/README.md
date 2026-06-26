# Agentcard integration

Lets Kilo issue and manage **Agentcard virtual cards on behalf of its end
users** via OAuth 2.1 + PKCE and the Agentcard MCP server. Each Kilo user
connects once ("Connect with Agentcard"); the bot then calls Agentcard card
tools with that user's bearer token. Cards are isolated per `(client, user)`.

## Pieces

| File | Responsibility |
| --- | --- |
| `config.ts` | Endpoints (pinned + discovered), env, redirect URI, enable flag |
| `crypto.ts` | PKCE (`generatePkce`, `pkceChallenge`) — mirrors `@/lib/mcp-gateway/crypto` |
| `oauth.ts` | Part 1 DCR + Part 2 PKCE: discovery, `registerClient`, `buildAuthorizeUrl`, `exchangeCodeForToken`, `refreshAccessToken`, `isExpired`, `revokeToken` |
| `store.ts` | Per-user token store (Redis, AES-256-GCM at rest) + single-use `state → {user, verifier}` |
| `mcp-client.ts` | Streamable-HTTP JSON-RPC MCP client (initialize → initialized → tools/list → tools/call), session id, approval helpers |
| `runtime.ts` | Client resolution, connect flow, valid-token resolution (refresh on near-expiry / 401), `callCardTool` |
| `tools.ts` | Curated AI-SDK card toolset bound to a Kilo user id (drops `buy`) |

Routes: `app/api/agentcard/connect/route.ts` (`GET ?user=<id>` → 302 `/authorize`)
and `app/api/agentcard/callback/route.ts` (code → token → persist). Wired into
the bot brain in `@/lib/bot/agent-runner.ts`, keyed by the stable Kilo
`user.id`.

## Client modes (Part 1)

- **Public (default):** leave `AGENTCARD_OAUTH_CLIENT_ID/SECRET` unset. We
  self-register via Dynamic Client Registration (no secret) and cache the
  `client_id` in Redis.
- **Pinned public:** set `AGENTCARD_OAUTH_CLIENT_ID` only.
- **Confidential:** set `AGENTCARD_OAUTH_CLIENT_ID` + `AGENTCARD_OAUTH_CLIENT_SECRET`
  (minted via the org endpoint, server-side only). The secret is sent on BOTH
  the code exchange and refresh; PKCE is still enforced.

## Env

See `.env.local.example` (`AGENTCARD_*`). `AGENTCARD_TOKEN_ENCRYPTION_KEY`
(base64 32 bytes) enables the integration. The OAuth redirect URI is
`<AGENTCARD_PUBLIC_BASE_URL or APP_URL>/api/agentcard/callback` and must match
the client's registered `redirect_uris` exactly.

## Flow

1. User asks the bot for a card while unconnected → bot shares
   `/api/agentcard/connect?user=<id>`.
2. `/connect` mints PKCE + `state`, redirects to Agentcard `/authorize`
   (`resource` + S256 enforced).
3. User approves → Agentcard redirects to `/callback` → we exchange the code
   (PKCE + `resource`) and persist the encrypted token bundle.
4. The bot now exposes `agentcard_*` tools; on a card request it calls
   `agentcard_create_card` immediately. Tokens refresh on near-expiry and on a
   401 (refresh rotates the refresh token, which is re-persisted).

## Gotchas honored

- `resource=https://mcp.agentcard.sh/mcp` is sent on **/authorize and /token**.
- Refresh **rotates** the refresh token — the new one is persisted every time.
- Confidential refresh also sends `client_secret`; PKCE always enforced.
- `create_card` / `get_card_details` approval gates resolve via `approve_request`.
- `buy` is intentionally not exposed; PAN/CVV are never logged.

## Tests

Offline unit tests (PKCE, OAuth exchange/refresh incl. confidential secret +
rotation, MCP handshake + approval + SSE) run without a DB/Redis:

```
cd apps/web && NODE_ENV=test pnpm exec jest -c jest.agentcard.config.ts
```

Live sandbox checks (discovery, DCR, MCP 401 gate) are curl-able against
`https://mcp.agentcard.sh`. Completing a real per-user connection requires a
human browser login at `/authorize`; hand the user the `/connect` link.
