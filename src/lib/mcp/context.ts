import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuth } from "@/lib/oauth";

/**
 * Per-request context for the MCP server: the verified access token's user,
 * grant, client, scopes and DEK (docs/vault-contract.md). Tools must only read
 * or write `auth.userId`'s data, check `auth.scopes` themselves, and never log
 * or return the DEK.
 */
export type RcsMcpContext = { readonly auth: McpAuth };

/** Registers one tool on a per-request server instance. One file per tool in `./tools`. */
export type RcsToolRegistrar = (server: McpServer, ctx: RcsMcpContext) => void;
