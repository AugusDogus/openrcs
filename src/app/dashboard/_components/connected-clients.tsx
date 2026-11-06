import { connection } from "next/server";
import { Alert, buttonClass, Card } from "@/app/_components/ui";
import { getDb } from "@/lib/db/client";
import { OAuthGrants } from "@/lib/oauth/grants";

// dateStyle/timeStyle cannot be combined with timeZoneName, so the zone is appended.
const timestampFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const formatTimestamp = (date: Date) => `${timestampFormat.format(date)} UTC`;

/**
 * The user's authorized MCP clients with a Revoke button each. Async server
 * component that reads the database: render it inside <Suspense>.
 * Client names come from dynamic registration and are untrusted; React
 * escapes them.
 */
export async function ConnectedClients({ userId }: { userId: string }) {
  await connection();
  const grants = await OAuthGrants.listActive(getDb(), userId);

  return (
    <Card
      title="Connected clients"
      description="MCP clients you approved. Revoking one signs it out immediately; it must ask you again to reconnect."
    >
      {grants.match({
        err: () => (
          <Alert tone="danger">
            Could not load your connected clients right now. They are unchanged; reload the page
            to try again.
          </Alert>
        ),
        ok: (list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted">No MCP clients are connected.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {list.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" title={grant.clientName}>
                      {grant.clientName}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted">{grant.scopes.join(" ")}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      Approved {formatTimestamp(grant.createdAt)} ·{" "}
                      {grant.lastUsedAt
                        ? `last used ${formatTimestamp(grant.lastUsedAt)}`
                        : "not used yet"}
                    </p>
                  </div>
                  <form
                    method="post"
                    action={`/api/oauth/grants/${encodeURIComponent(grant.id)}/revoke`}
                  >
                    <button type="submit" className={buttonClass("secondary", "h-9 shrink-0 px-3")}>
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ),
      })}
    </Card>
  );
}
