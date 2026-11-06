import { defineConfig } from "drizzle-kit";

// `db:generate` only reads the schema. Credentials are used by drizzle-kit
// commands that connect (studio, check against a live DB); migrations are
// applied with `bun run db:migrate`.
export default defineConfig({
  dialect: "turso",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? "file:./.data/dev.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
