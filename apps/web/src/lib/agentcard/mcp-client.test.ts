import {
  createAgentcardMcpClient,
  extractToolPayload,
  getApprovalId,
  McpUnauthorizedError,
} from './mcp-client';

const SESSION_ID = 'sess-abc-123';

/** Minimal in-memory Agentcard MCP server over JSON-RPC for tests. */
function mockMcpServer(opts: { unauthorizedFirstCall?: boolean } = {}) {
  const received: Array<{ method: string; params?: unknown; sessionId: string | null }> = [];
  let createCardCalls = 0;
  let unauthorizedConsumed = false;

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const sessionId = (init?.headers as Record<string, string>)?.['Mcp-Session-Id'] ?? null;
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: any };
    received.push({ method: msg.method, params: msg.params, sessionId });

    if (opts.unauthorizedFirstCall && !unauthorizedConsumed && msg.method === 'tools/call') {
      unauthorizedConsumed = true;
      return new Response(null, { status: 401 });
    }

    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION_ID },
      });

    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'agentcard' },
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': SESSION_ID } });
      case 'tools/list':
        return reply({
          tools: [
            { name: 'create_card' },
            { name: 'list_cards' },
            { name: 'approve_request' },
            { name: 'buy' },
          ],
        });
      case 'tools/call': {
        const name = msg.params?.name;
        if (name === 'create_card') {
          createCardCalls++;
          if (createCardCalls === 1) {
            return reply({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ approval_required: true, approval_id: 'appr-1' }),
                },
              ],
            });
          }
          return reply({
            structuredContent: { card_id: 'card-1', last4: '4242', amount_cents: 5000 },
          });
        }
        if (name === 'approve_request') {
          return reply({
            structuredContent: { approved: true, approval_id: msg.params?.arguments?.approval_id },
          });
        }
        if (name === 'list_cards') {
          return reply({ structuredContent: { cards: [{ card_id: 'card-1' }] } });
        }
        return reply({ structuredContent: {} });
      }
      default:
        return reply({});
    }
  }) as typeof fetch;

  return { fetchImpl, received, getCreateCardCalls: () => createCardCalls };
}

describe('agentcard/mcp-client', () => {
  it('performs the initialize -> initialized -> tools/list handshake and echoes the session id', async () => {
    const server = mockMcpServer();
    const client = createAgentcardMcpClient({
      accessToken: 'bearer-1',
      fetchImpl: server.fetchImpl,
    });

    const tools = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['create_card', 'list_cards', 'approve_request', 'buy']);

    const methods = server.received.map(r => r.method);
    expect(methods.slice(0, 3)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    // Session id from the initialize response is echoed on subsequent calls.
    expect(client.sessionId).toBe(SESSION_ID);
    expect(server.received[2].sessionId).toBe(SESSION_ID);
  });

  it('drives the approval-required -> approve_request -> retry path', async () => {
    const server = mockMcpServer();
    const client = createAgentcardMcpClient({ accessToken: 'b', fetchImpl: server.fetchImpl });

    const first = await client.callTool('create_card', { amount_cents: 5000 });
    const approvalId = getApprovalId(first);
    expect(approvalId).toBe('appr-1');

    const approve = await client.callTool('approve_request', { approval_id: approvalId! });
    expect(extractToolPayload(approve)).toMatchObject({ approved: true });

    const retried = await client.callTool('create_card', { amount_cents: 5000 });
    expect(extractToolPayload(retried)).toMatchObject({ card_id: 'card-1', last4: '4242' });
  });

  it('throws McpUnauthorizedError on HTTP 401', async () => {
    const server = mockMcpServer({ unauthorizedFirstCall: true });
    const client = createAgentcardMcpClient({
      accessToken: 'expired',
      fetchImpl: server.fetchImpl,
    });
    await expect(client.callTool('list_cards', {})).rejects.toBeInstanceOf(McpUnauthorizedError);
  });

  it('parses Streamable-HTTP SSE (text/event-stream) responses', async () => {
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: msg.method === 'tools/call' ? { structuredContent: { ok: true } } : {},
      });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const client = createAgentcardMcpClient({ accessToken: 'b', fetchImpl });
    const result = await client.callTool('check_balance', {});
    expect(extractToolPayload(result)).toMatchObject({ ok: true });
  });
});
