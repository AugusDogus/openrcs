import { Env } from "@/lib/env";

/**
 * Everything the vault needs besides the database: the server's KEY_PEPPER
 * and the clock. The contract-level functions use `VaultConfig.fromEnv()`;
 * the `*With` variants take one explicitly (tests).
 */
export type VaultConfig = {
  /** KEY_PEPPER bytes (32). Never log. */
  readonly pepper: Uint8Array;
  /** Unix epoch milliseconds. */
  readonly now: () => number;
};

let cached: VaultConfig | undefined;

export const VaultConfig = {
  /** From KEY_PEPPER. Throws `InvalidEnvError` naming the variable to fix when it is missing (deployment misconfiguration). */
  fromEnv: (): VaultConfig => {
    if (cached) return cached;
    cached = { pepper: new Uint8Array(Buffer.from(Env.vault().KEY_PEPPER, "base64")), now: () => Date.now() };
    return cached;
  },
} as const;
