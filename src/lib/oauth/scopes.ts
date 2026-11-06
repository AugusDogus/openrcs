/** OAuth scopes for the MCP resource (docs/security.md). */
export type McpScope = "messages:read" | "messages:send";

const all: readonly McpScope[] = ["messages:read", "messages:send"];

const isScope = (value: string): value is McpScope => all.some((scope) => scope === value);

/** Space-separated scope string -> known scopes (canonical order, deduplicated) and unknown tokens. */
const parse = (value: string): { readonly scopes: McpScope[]; readonly unknown: string[] } => {
  const tokens = value.split(" ").filter((token) => token.length > 0);
  const unknown = tokens.filter((token) => !isScope(token));
  return { scopes: all.filter((scope) => tokens.includes(scope)), unknown };
};

const format = (scopes: readonly McpScope[]): string =>
  all.filter((scope) => scopes.includes(scope)).join(" ");

const intersect = (a: readonly McpScope[], b: readonly McpScope[]): McpScope[] =>
  all.filter((scope) => a.includes(scope) && b.includes(scope));

const includesAll = (have: readonly McpScope[], need: readonly McpScope[]): boolean =>
  need.every((scope) => have.includes(scope));

const descriptions: Record<McpScope, string> = {
  "messages:read": "Read your conversations and messages",
  "messages:send": "Send messages from your phone",
};

export const McpScope = {
  read: "messages:read",
  send: "messages:send",
  all,
  /** Registered clients get both scopes unless they ask for fewer. */
  defaultString: format(all),
  isScope,
  parse,
  format,
  intersect,
  includesAll,
  describe: (scope: McpScope): string => descriptions[scope],
} as const;
