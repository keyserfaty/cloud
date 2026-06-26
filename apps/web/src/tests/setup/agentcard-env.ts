/**
 * Minimal env for the Agentcard offline unit tests (see jest.agentcard.config.ts).
 * The repo's normal test run provides these via the DB globalSetup, which the
 * offline config intentionally skips. These are placeholders only — the
 * Agentcard tests never make real network/DB calls.
 */
process.env.NEXT_PUBLIC_GASTOWN_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_KILO_CHAT_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_EVENT_SERVICE_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_WASTELAND_URL ??= 'http://localhost:3000';
process.env.APP_URL_OVERRIDE ??= 'http://localhost:3000';
