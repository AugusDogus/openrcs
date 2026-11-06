import type { ReactNode } from "react";
import { Card } from "@/app/_components/ui";
import { CopyButton } from "../client-actions";

/** "Connect an AI agent" card: the MCP URL and copyable setup snippets. */

function Snippet({ title, value, children }: { title: string; value: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <CopyButton value={value} />
      </div>
      {children}
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface-muted p-3 font-mono text-xs leading-5">
        {value}
      </pre>
    </div>
  );
}

export function AgentSetup({ mcpUrl }: { mcpUrl: string }) {
  const claudeCode = `claude mcp add --transport http openrcs ${mcpUrl}`;
  const jsonConfig = JSON.stringify({ mcpServers: { openrcs: { url: mcpUrl } } }, null, 2);
  return (
    <Card
      title="Connect an AI agent"
      description="Add openrcs as a remote MCP server. Your agent signs in with OAuth; approve it from this browser."
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted p-1.5 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-sm" title={mcpUrl}>
            {mcpUrl}
          </code>
          <CopyButton value={mcpUrl} label="Copy URL" />
        </div>
        <Snippet title="Claude Code" value={claudeCode} />
        <Snippet title="Claude Desktop, Cursor and other JSON-configured clients" value={jsonConfig}>
          <p className="text-xs leading-5 text-muted">
            Add this to the client&apos;s MCP config file (for clients that only support local servers, use
            their &quot;remote&quot; or &quot;custom connector&quot; option with the URL above).
          </p>
        </Snippet>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">executor.sh</h3>
          <p className="text-sm leading-6 text-muted">
            Add a remote MCP service and paste the URL above. Executor opens the openrcs sign-in in your
            browser; approve it there.
          </p>
        </div>
      </div>
    </Card>
  );
}
