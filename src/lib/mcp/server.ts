import { McpServer } from "@modelcontextprotocol/server";
import type { RcsMcpContext } from "./context";
import { rcsTools } from "./tools";

export type { RcsMcpContext, RcsToolRegistrar } from "./context";

const instructions = [
  "openrcs reads and sends the user's SMS/RCS messages through their phone's Google Messages.",
  "Workflow: call get_status first. If the phone is not 'paired', ask the user to pair or re-pair it in the openrcs dashboard (needs_repair still allows reading stored messages).",
  "Conversation ids are opaque: get them from list_conversations (use its `query` to find a contact by name or number), then call get_messages or search_messages with them.",
  "Read tools sync with the phone automatically (at most once a minute) and fall back to stored messages, saying so, when the phone is unreachable.",
  "search_messages scans encrypted messages newest first and reports when its scan limit was hit; narrow by conversation_id or since/until (YYYY-MM-DD, UTC) to go further back.",
  "send_message sends a real text from the user's phone: confirm the recipient and wording with the user first. If it reports the phone did not confirm, check get_messages before retrying.",
  "Timestamps are ISO 8601 UTC.",
].join("\n");

/**
 * Builds a fresh MCP server bound to one authenticated grant. Called once per
 * HTTP request by the `/api/mcp` route (stateless serving).
 */
export const createRcsMcpServer = (ctx: RcsMcpContext): McpServer => {
  const server = new McpServer({ name: "openrcs", version: "0.2.0" }, { instructions });
  for (const register of rcsTools) register(server, ctx);
  return server;
};
