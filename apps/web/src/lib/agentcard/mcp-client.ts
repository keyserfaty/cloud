import 'server-only';
import { AGENTCARD_MCP_URL } from './config';

/**
 * Part 3 — Agentcard MCP client over Streamable HTTP (JSON-RPC 2.0).
 *
 * The host repo has no AI-SDK MCP *client* to mirror (its MCP code is servers
 * and an OAuth gateway), so we hand-roll a minimal Streamable-HTTP client:
 *   initialize -> notifications/initialized -> tools/list -> tools/call
 * echoing the `Mcp-Session-Id` returned by the server.
 *
 * Pure transport: a custom `fetch` can be injected for tests.
 */

const PROTOCOL_VERSION = '2025-06-18';
const JSONRPC = '2.0';

type FetchImpl = typeof fetch;

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolResult = {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
};

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** Thrown on HTTP 401 so callers can refresh the token and retry. */
export class McpUnauthorizedError extends McpError {
  constructor(message = 'Agentcard MCP returned 401') {
    super(message, undefined, 401);
    this.name = 'McpUnauthorizedError';
  }
}

/**
 * Parse a Streamable-HTTP response that may be either `application/json` or
 * an SSE (`text/event-stream`) carrying one JSON-RPC `data:` event.
 */
async function parseRpcResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (
    contentType.includes('text/event-stream') ||
    text.startsWith('event:') ||
    text.includes('\ndata:') ||
    text.startsWith('data:')
  ) {
    // Take the last non-empty `data:` payload.
    let payload: string | null = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith('data:')) payload = trimmed.slice('data:'.length).trim();
    }
    if (payload == null) throw new McpError('MCP SSE response contained no data event');
    return JSON.parse(payload);
  }
  return text ? JSON.parse(text) : null;
}

export function createAgentcardMcpClient(params: {
  accessToken: string;
  url?: string;
  fetchImpl?: FetchImpl;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = params.url ?? AGENTCARD_MCP_URL;
  let sessionId: string | null = null;
  let nextId = 1;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    return h;
  }

  async function send(
    method: string,
    rpcParams?: unknown,
    isNotification = false
  ): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: JSONRPC, method };
    if (rpcParams !== undefined) body.params = rpcParams;
    if (!isNotification) body.id = nextId++;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });

    // Capture the session id from the initialize response (or any response).
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) sessionId = returnedSession;

    if (response.status === 401) throw new McpUnauthorizedError();
    if (!response.ok && response.status !== 202) {
      throw new McpError(
        `Agentcard MCP request failed: ${response.status}`,
        undefined,
        response.status
      );
    }
    if (isNotification) return null;

    const parsed = (await parseRpcResponse(response)) as {
      result?: unknown;
      error?: { code: number; message: string };
    } | null;
    if (parsed && parsed.error) {
      throw new McpError(parsed.error.message, parsed.error.code);
    }
    return parsed?.result ?? null;
  }

  let initialized = false;
  async function initialize(): Promise<void> {
    if (initialized) return;
    await send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'kilo-agentcard', version: '1.0.0' },
    });
    await send('notifications/initialized', undefined, true);
    initialized = true;
  }

  return {
    async listTools(): Promise<McpToolDefinition[]> {
      await initialize();
      const result = (await send('tools/list')) as { tools?: McpToolDefinition[] } | null;
      return result?.tools ?? [];
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
      await initialize();
      const result = (await send('tools/call', { name, arguments: args })) as McpToolResult | null;
      return result ?? {};
    },
    get sessionId(): string | null {
      return sessionId;
    },
  };
}

export type AgentcardMcpClient = ReturnType<typeof createAgentcardMcpClient>;

/**
 * Extract a JSON object from an MCP tool result. Card tools return their
 * payload either as `structuredContent` or as a JSON string in the first
 * text content block.
 */
export function extractToolPayload(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const firstText = result.content?.find(c => c.type === 'text')?.text;
  if (typeof firstText === 'string') {
    try {
      return JSON.parse(firstText);
    } catch {
      return firstText;
    }
  }
  return result.content ?? null;
}

/**
 * Detect an approval gate in a tool result. `create_card` / `get_card_details`
 * may return `approval_required` + `approval_id`, resolved via `approve_request`.
 */
export function getApprovalId(result: McpToolResult): string | null {
  const payload = extractToolPayload(result);
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const required =
      obj.approval_required === true ||
      obj.status === 'approval_required' ||
      typeof obj.approval_id === 'string';
    const id = obj.approval_id ?? obj.approvalId;
    if (required && typeof id === 'string') return id;
  }
  return null;
}
