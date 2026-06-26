import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isAgentcardEnabled } from '@/lib/agentcard/config';
import { completeConnect, reportAgentcardError } from '@/lib/agentcard/runtime';

/**
 * GET /api/agentcard/callback?code=...&state=...
 *
 * OAuth redirect target. Exchanges the authorization code for tokens (PKCE) and
 * persists them keyed by the user id carried in `state`. This URL must match the
 * `redirect_uris` registered for the client EXACTLY.
 */
function htmlResponse(message: string, status = 200): Response {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Agentcard</title></head><body style="font-family:system-ui;padding:2rem"><h1>${message}</h1><p>You can close this window and return to the chat.</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAgentcardEnabled()) {
    return htmlResponse('Agentcard is not configured.', 503);
  }

  const params = request.nextUrl.searchParams;
  const error = params.get('error');
  if (error) {
    return htmlResponse('Agentcard connection was cancelled or denied.', 400);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    return htmlResponse('Missing authorization code or state.', 400);
  }

  try {
    await completeConnect({ code, state });
    return htmlResponse('✅ Agentcard connected!');
  } catch (err) {
    reportAgentcardError('callback', err);
    return htmlResponse('Could not complete the Agentcard connection. Please try again.', 502);
  }
}
