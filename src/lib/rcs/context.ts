import type { Dek } from "@/lib/vault/dek";

/**
 * Who the service layer acts for and the key that opens their data. The DEK
 * is unwrapped from the user's server key (src/lib/vault/server-key.ts) when
 * needed and must never be logged or stored.
 */
export type RcsContext = {
  readonly userId: string;
  readonly dek: Dek;
};
