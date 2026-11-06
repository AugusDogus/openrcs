import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Per-request context for the MCP server: the authenticated user the access
 * token was issued to. Tools must only read or write this user's data.
 * Granted OAuth scopes reach tool callbacks through the SDK's
 * `ctx.http?.authInfo` (see `toAuthInfo` in the MCP route).
 */
export type RcsMcpContext = {
  readonly userId: string;
};

/** Registers one tool on a per-request server instance. One file per tool in `./tools`. */
export type RcsToolRegistrar = (server: McpServer, ctx: RcsMcpContext) => void;
