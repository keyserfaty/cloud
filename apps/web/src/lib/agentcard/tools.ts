import 'server-only';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { callCardTool, extractToolPayload } from './runtime';

/**
 * Part 6/7 — curated Agentcard card toolset exposed to the LLM brain.
 *
 * Each tool is bound to a single Kilo user id (the stable token-store key) and
 * proxies to the Agentcard MCP server with that user's bearer token. The `buy`
 * tool is intentionally NOT exposed (curated toolset).
 *
 * Tool results are returned to the model so it can answer the user; we never
 * log PAN/CVV (results are not logged here).
 */

async function run(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  autoApprove = false
): Promise<unknown> {
  const result = await callCardTool(userId, name, args, { autoApprove });
  return extractToolPayload(result);
}

/**
 * Build the curated Agentcard toolset for `userId`. Returns an AI SDK `ToolSet`
 * ready to merge into the agent's `tools`.
 */
export function buildAgentcardTools(userId: string): ToolSet {
  return {
    agentcard_create_card: tool({
      description:
        'Create a new Agentcard virtual card for the user with a spending limit. When the user asks for a card, CALL THIS IMMEDIATELY — do not ask "want me to create a card?". amount_cents is the limit in cents (e.g. 5000 = $50).',
      inputSchema: z.object({
        amount_cents: z
          .number()
          .int()
          .positive()
          .describe('Spending limit in cents (e.g. 5000 = $50.00)'),
      }),
      execute: ({ amount_cents }) =>
        run(userId, 'create_card', { amount_cents }, /* autoApprove */ true),
    }),
    agentcard_list_cards: tool({
      description:
        "List the user's Agentcard virtual cards issued through this app. An empty list for a newly connected user is normal (cards are isolated per app + user).",
      inputSchema: z.object({}),
      execute: () => run(userId, 'list_cards', {}),
    }),
    agentcard_get_card_details: tool({
      description:
        'Get details for one Agentcard card by id. May require approval; approval is resolved automatically.',
      inputSchema: z.object({
        card_id: z.string().describe('The id of the card to fetch details for'),
      }),
      execute: ({ card_id }) =>
        run(userId, 'get_card_details', { card_id }, /* autoApprove */ true),
    }),
    agentcard_check_balance: tool({
      description: "Check the balance / available funds on the user's Agentcard account.",
      inputSchema: z.object({}),
      execute: () => run(userId, 'check_balance', {}),
    }),
    agentcard_close_card: tool({
      description: 'Permanently close an Agentcard virtual card by id.',
      inputSchema: z.object({
        card_id: z.string().describe('The id of the card to close'),
      }),
      execute: ({ card_id }) => run(userId, 'close_card', { card_id }),
    }),
    agentcard_list_transactions: tool({
      description: 'List recent transactions on the user’s Agentcard cards.',
      inputSchema: z.object({
        card_id: z.string().optional().describe('Optional card id to filter transactions'),
      }),
      execute: ({ card_id }) => run(userId, 'list_transactions', card_id ? { card_id } : {}),
    }),
    agentcard_approve_request: tool({
      description:
        'Approve a pending Agentcard request (e.g. an approval gate returned by another tool) by approval_id.',
      inputSchema: z.object({
        approval_id: z.string().describe('The approval_id returned by a prior tool call'),
      }),
      execute: ({ approval_id }) => run(userId, 'approve_request', { approval_id }),
    }),
    agentcard_get_plan: tool({
      description: "Get the user's Agentcard plan / limits.",
      inputSchema: z.object({}),
      execute: () => run(userId, 'get_plan', {}),
    }),
  };
}
