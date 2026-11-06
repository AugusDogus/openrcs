/**
 * OAuth scopes for the MCP resource. Identity scopes stay on the
 * authorization server; the `messages:*` scopes are advertised in the
 * protected-resource metadata so MCP clients request them.
 */
export type McpScope = (typeof McpScope.all)[number];

export const McpScope = {
  read: "messages:read",
  send: "messages:send",
  all: ["messages:read", "messages:send"],
  /** Every scope the authorization server accepts. */
  supported: ["openid", "profile", "email", "offline_access", "messages:read", "messages:send"],
  /** Capability set persisted for dynamically registered / CIMD clients. */
  registrationDefault: ["openid", "profile", "offline_access", "messages:read", "messages:send"],
} as const;
