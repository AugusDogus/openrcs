import { McpServer } from "@modelcontextprotocol/server";
import type { RcsMcpContext } from "@/lib/mcp/context";
import { rcsTools } from "@/lib/mcp/tools";

export type { RcsMcpContext } from "@/lib/mcp/context";

/**
 * Builds a fresh MCP server bound to one authenticated user. Called once per
 * HTTP request by the `/api/mcp` route (stateless serving).
 */
export const createRcsMcpServer = (ctx: RcsMcpContext): McpServer => {
  const server = new McpServer({ name: "openrcs", version: "0.1.0" });
  for (const register of rcsTools) register(server, ctx);
  return server;
};
