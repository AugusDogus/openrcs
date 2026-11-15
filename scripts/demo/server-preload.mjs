/**
 * Loaded into the Next.js server process of the demo recording only
 * (`NODE_OPTIONS=--import`, see ./record.ts). It never runs in the app.
 *
 * - Turns off the background sync: the demo's paired phone is fake, so the
 *   server must never try to reach Google with it. The app starts its
 *   scheduler only when `globalThis.__openrcsBackgroundSync` is unset
 *   (src/lib/rcs/background-sync.ts).
 * - Owns the first-sync registry the dashboard reads
 *   (`globalThis.__openrcsFirstSync`, src/lib/rcs/first-sync.ts) and lets the
 *   recording script set its progress over a loopback HTTP port:
 *   `PUT /first-sync/<userId>` with `{ "done": 3, "total": 40 | null }`,
 *   `DELETE /first-sync/<userId>` when it is over.
 */
import { createServer } from "node:http";

globalThis.__openrcsBackgroundSync = { stop: () => {} };
globalThis.__openrcsFirstSync ??= new Map();
const registry = globalThis.__openrcsFirstSync;

const port = Number(process.env.DEMO_CONTROL_PORT);
if (Number.isInteger(port) && port > 0) {
  const server = createServer((request, response) => {
    const match = /^\/first-sync\/([^/]+)$/.exec(request.url ?? "");
    if (match === null) {
      response.writeHead(404).end();
      return;
    }
    const userId = decodeURIComponent(match[1]);
    if (request.method === "DELETE") {
      registry.delete(userId);
      response.writeHead(204).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { done, total } = JSON.parse(body);
      const entry = registry.get(userId);
      if (entry) entry.progress = { done, total };
      else registry.set(userId, { progress: { done, total }, abort: new AbortController() });
      response.writeHead(204).end();
    });
  });
  // A child process inheriting NODE_OPTIONS finds the port taken; only the first one serves.
  server.on("error", () => {});
  server.listen(port, "127.0.0.1");
  server.unref();
}
