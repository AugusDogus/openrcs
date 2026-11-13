import { connection } from "next/server";
import { Alert, buttonClass, Section } from "@/app/_components/ui";
import { timeAgo } from "@/app/_lib/time";
import { getDb } from "@/lib/db/client";
import { OAuthGrants } from "@/lib/oauth/grants";
import { CopyButton } from "../client-actions";

/**
 * The MCP address to give an agent, and the agents already approved, each
 * revocable. Reads the database: render inside <Suspense>. Client names come
 * from dynamic registration and are untrusted; React escapes them.
 */
export async function Agents({ userId, mcpUrl }: { userId: string; mcpUrl: string }) {
  await connection();
  const grants = await OAuthGrants.listActive(getDb(), userId);
  const now = new Date();

  return (
    <Section title="Agents">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pr-1.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={mcpUrl}>
          {mcpUrl}
        </code>
        <CopyButton value={mcpUrl} />
      </div>
      {grants.match({
        err: () => (
          <Alert tone="danger">Could not load your agents. They are unchanged; reload the page to try again.</Alert>
        ),
        ok: (list) =>
          list.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              Add this address to an MCP client as a remote server. It shows up here once you approve it.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {list.map((grant) => (
                <li key={grant.id} className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={grant.clientName}>
                      {grant.clientName}
                    </p>
                    <p className="text-sm text-muted">
                      {grant.lastUsedAt ? `Used ${timeAgo(grant.lastUsedAt, now)}` : `Approved ${timeAgo(grant.createdAt, now)}`}
                    </p>
                  </div>
                  <form method="post" action={`/api/oauth/grants/${encodeURIComponent(grant.id)}/revoke`}>
                    <button type="submit" className={buttonClass("ghost")}>
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ),
      })}
    </Section>
  );
}
