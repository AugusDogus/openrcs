import { randomBytes } from "node:crypto";
import { Base64Url } from "./base64url";

export const DEK_BYTES = 32;
const ID_BYTES = 16;

/**
 * A user's data encryption key (docs/security.md). `id` is the non-secret
 * `dek_id` stored on key slots, grants and `gm_session`; `bytes` is the
 * secret key and only ever exists in memory during a request. Never log it.
 */
export type Dek = { readonly id: string; readonly bytes: Uint8Array };

/** Random non-secret identifier (base64url of 16 random bytes). */
const randomId = (): string => Base64Url.encode(randomBytes(ID_BYTES));

export const Dek = {
  generate: (): Dek => ({ id: randomId(), bytes: new Uint8Array(randomBytes(DEK_BYTES)) }),
  /** Rebuilds a DEK from unwrapped bytes; `undefined` unless exactly 32 bytes. */
  fromBytes: (id: string, bytes: Uint8Array): Dek | undefined =>
    bytes.byteLength === DEK_BYTES ? { id, bytes } : undefined,
  randomId,
} as const;
