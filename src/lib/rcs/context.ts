import type { Dek } from "@/lib/vault/dek";

/**
 * Who the service layer acts for and the key that opens their data. The DEK
 * is unwrapped per request from the caller's key slot or access token
 * (docs/security.md) and must never be logged or stored.
 */
export type RcsContext = {
  readonly userId: string;
  readonly dek: Dek;
};
