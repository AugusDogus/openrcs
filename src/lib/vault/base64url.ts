const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Unpadded base64url (RFC 4648 section 5). `decode` is strict: Node's decoder
 * silently drops trailing characters and non-zero padding bits, so the input
 * must be the canonical encoding of the bytes it decodes to.
 */
export const Base64Url = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url"),
  /** The decoded bytes, or `undefined` when `value` is empty or not canonical base64url. */
  decode: (value: string): Uint8Array | undefined => {
    if (!base64UrlPattern.test(value)) return undefined;
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value ? new Uint8Array(bytes) : undefined;
  },
} as const;
