import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isAgentcardEnabled } from '@/lib/agentcard/config';
import { beginConnect, reportAgentcardError } from '@/lib/agentcard/runtime';

/**
 * GET /api/agentcard/connect?user=<stableUserId>
 *
 * Mints PKCE + state for the user and 302-redirects to the Agentcard
 * /authorize endpoint ("Connect with Agentcard"). The `user` query param is the
 * stable key the resulting tokens are stored under.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!isAgentcardEnabled()) {
    return NextResponse.json({ error: 'agentcard_not_configured' }, { status: 503 });
  }

  const userId = request.nextUrl.searchParams.get('user');
  if (!userId) {
    return NextResponse.json({ error: 'missing_user' }, { status: 400 });
  }

  try {
    const authorizeUrl = await beginConnect(userId);
    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    reportAgentcardError('connect', error);
    return NextResponse.json({ error: 'agentcard_connect_failed' }, { status: 502 });
  }
}
