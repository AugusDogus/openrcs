import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { Env } from "@/lib/env";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

export type DatabaseConfig = {
  /** `file:./.data/dev.db`, `libsql://...` or `:memory:`. */
  readonly url: string;
  readonly authToken?: string;
};

export const createDatabase = (config: DatabaseConfig): Database => {
  const client = createClient({ url: config.url, authToken: config.authToken });
  return drizzle(client, { schema });
};

let instance: Database | undefined;

/**
 * The app database (Turso / libSQL), created on first use. Throws
 * `InvalidEnvError` when TURSO_DATABASE_URL is missing or malformed.
 */
export const getDb = (): Database => {
  if (instance) return instance;
  const env = Env.database();
  instance = createDatabase({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  return instance;
};
