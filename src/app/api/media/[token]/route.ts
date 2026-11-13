import { getDb } from "@/lib/db/client";
import { MediaLink } from "@/lib/rcs/media-link";

/**
 * Download link handed out by the `get_media` MCP tool. The path is the only
 * credential: `<id>.<secret>`, valid for 10 minutes (src/lib/rcs/media-link.ts).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/media/[token]">): Promise<Response> {
  const { token } = await ctx.params;
  return MediaLink.respond(MediaLink.configFromEnv(getDb()), token, { signal: request.signal });
}
