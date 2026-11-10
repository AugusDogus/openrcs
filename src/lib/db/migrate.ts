/**
 * Applies the SQL migrations in ./drizzle to TURSO_DATABASE_URL.
 * Works for `file:` (local dev, creates the parent directory) and remote
 * `libsql://` databases. Run with `bun run db:migrate`; Bun loads .env.local.
 * The Docker image runs a bundled copy on every start (docker/entrypoint.sh).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDatabase } from "@/lib/db/client";
import { Env, InvalidEnvError } from "@/lib/env";

// The Docker image bundles this script, so it names the folder explicitly.
const migrationsFolder =
  process.env.OPENRCS_MIGRATIONS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

const ensureLocalDirectory = (url: string) => {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  mkdirSync(dirname(resolve(path)), { recursive: true });
};

const describeTarget = (url: string) =>
  url.startsWith("file:") ? url : `${new URL(url).protocol}//${new URL(url).host}`;

const main = async () => {
  const env = Env.database();
  ensureLocalDirectory(env.TURSO_DATABASE_URL);
  const db = createDatabase({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  const target = describeTarget(env.TURSO_DATABASE_URL);
  console.log(`Applying migrations from ${migrationsFolder} to ${target}`);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    db.$client.close();
  }
  console.log("Migrations applied.");
};

main().catch((error: unknown) => {
  if (InvalidEnvError.is(error)) {
    console.error(error.message);
  } else {
    console.error(
      "Migration failed. Already-applied migrations are recorded in __drizzle_migrations and are not re-run; fix the error and run `bun run db:migrate` again.",
    );
    console.error(error);
  }
  process.exit(1);
});
