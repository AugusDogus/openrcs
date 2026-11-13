import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { Env } from "@/lib/env";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

export type DatabaseConfig = {
  /** `file:./.data/dev.db`, `libsql://...` or `:memory:`. */
  readonly url: string;
};

export const createDatabase = (config: DatabaseConfig): Database => {
  const client = createClient({ url: config.url });
  return drizzle(client, { schema });
};

let instance: Database | undefined;

/**
 * The app database (libSQL / SQLite), created on first use. Throws
 * `InvalidEnvError` when DATABASE_URL is missing or malformed.
 */
export const getDb = (): Database => {
  if (instance) return instance;
  const env = Env.database();
  instance = createDatabase({ url: env.DATABASE_URL });
  return instance;
};
