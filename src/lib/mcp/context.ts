import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuth } from "@/lib/oauth";
import type { MediaLinkConfig } from "@/lib/rcs/media-link";
import type { WithPhoneOptions } from "@/lib/rcs/phone";

/**
 * Per-request context for the MCP server: the verified access token's user,
 * grant, client, scopes and DEK (docs/vault-contract.md). Tools must only read
 * or write `auth.userId`'s data, check `auth.scopes` themselves, and never log
 * or return the DEK.
 */
export type RcsMcpContext = {
  readonly auth: McpAuth;
  /** Test-only: a scripted phone and link settings instead of Google and the environment. */
  readonly testing?: { readonly phone?: WithPhoneOptions; readonly mediaLink?: MediaLinkConfig };
};

/** Registers one tool on a per-request server instance. One file per tool in `./tools`. */
export type RcsToolRegistrar = (server: McpServer, ctx: RcsMcpContext) => void;
