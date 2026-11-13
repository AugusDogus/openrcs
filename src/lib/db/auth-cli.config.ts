/**
 * Entry point for the Better Auth CLI (`bun run db:auth-schema`), which
 * regenerates `auth-schema.ts` from the plugin configuration in `../auth.ts`.
 * Uses placeholder settings and an in-memory database; nothing here runs in
 * the app.
 */
import { createClient } from "@libsql/client";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/libsql";
import { createAuth } from "../auth";

export const auth = createAuth({
  baseURL: "http://localhost:3000",
  secret: "auth-cli-placeholder-secret-not-used-at-runtime",
  database: drizzleAdapter(drizzle(createClient({ url: ":memory:" })), { provider: "sqlite" }),
});
