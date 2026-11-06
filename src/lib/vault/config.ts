import { Env } from "@/lib/env";

/** Device cookie name and attributes for the deployment's scheme. */
export type DeviceCookieSettings = {
  /**
   * Base name: "__Host-openrcs-device" over https, "__openrcs-device" over
   * http (local dev). Each account's cookie appends a tag (DeviceCookie.nameFor).
   */
  readonly name: string;
  readonly secure: boolean;
};

/**
 * Everything the vault needs besides the database: the server key share and
 * the clock. The contract-level functions use `VaultConfig.fromEnv()`; the
 * `*With` variants take one explicitly (tests, alternative deployments).
 */
export type VaultConfig = {
  /** KEY_PEPPER bytes (32). Never log. */
  readonly pepper: Uint8Array;
  readonly deviceCookie: DeviceCookieSettings;
  /** Unix epoch milliseconds. */
  readonly now: () => number;
};

const SECURE_DEVICE_COOKIE = "__Host-openrcs-device";
const INSECURE_DEVICE_COOKIE = "__openrcs-device";

const deviceCookieFor = (origin: string): DeviceCookieSettings =>
  new URL(origin).protocol === "https:"
    ? { name: SECURE_DEVICE_COOKIE, secure: true }
    : { name: INSECURE_DEVICE_COOKIE, secure: false };

let cached: VaultConfig | undefined;

export const VaultConfig = {
  SECURE_DEVICE_COOKIE,
  INSECURE_DEVICE_COOKIE,
  deviceCookieFor,
  /**
   * From KEY_PEPPER and BETTER_AUTH_URL. Throws `InvalidEnvError` naming the
   * variables to fix when either is missing (deployment misconfiguration).
   */
  fromEnv: (): VaultConfig => {
    if (cached) return cached;
    const pepper = new Uint8Array(Buffer.from(Env.vault().KEY_PEPPER, "base64"));
    cached = {
      pepper,
      deviceCookie: deviceCookieFor(Env.auth().BETTER_AUTH_URL),
      now: () => Date.now(),
    };
    return cached;
  },
} as const;
