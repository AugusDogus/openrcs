import { requireScopes, type CallToolResult } from "@modelcontextprotocol/server";
import type { McpScope } from "@/lib/oauth/scopes";
import type { RcsMcpContext } from "./context";

/**
 * Scope checks for tools. Each tool declares the scope it needs twice:
 * `challenge` lets the HTTP layer answer 403 insufficient_scope when the
 * route passes authInfo, and `check` is the in-tool guard that always runs
 * (contract: tools check `ctx.auth.scopes` themselves).
 */
const READ: McpScope = "messages:read";
const SEND: McpScope = "messages:send";

const purpose: Record<McpScope, string> = {
  "messages:read": "read conversations, messages and contacts",
  "messages:send": "send messages",
};

/** `null` when granted, else an isError result naming the missing scope and the fix. */
const check = (ctx: RcsMcpContext, scope: McpScope): CallToolResult | null =>
  ctx.auth.scopes.includes(scope)
    ? null
    : {
        isError: true,
        content: [
          {
            type: "text",
            text: `This tool needs the "${scope}" scope (to ${purpose[scope]}), but this client was authorized with ${
              ctx.auth.scopes.length > 0 ? `only: ${ctx.auth.scopes.join(", ")}` : "no message scopes"
            }. Nothing was done. Re-authorize the client with "${scope}" (disconnect and reconnect it, then approve the scope in the openrcs browser window).`,
          },
        ],
      };

export const ToolScope = {
  read: READ,
  send: SEND,
  check,
  challenge: (scope: McpScope) => requireScopes(scope),
} as const;
