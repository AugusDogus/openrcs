import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { DeviceSchema, type Device } from "@/gen/gmproto/authentication_pb";

import { GOOGLE_NETWORK } from "./constants";
import { AesCtrHelper } from "./crypto/aes-ctr";
import { Jwk } from "./crypto/jwk";

// libgm client.go AuthData: everything needed to talk to the paired phone.
// Serialized as our own versioned JSON (not libgm's): bytes are base64 (std,
// padded), Device is base64 of its binary protobuf, bigint is a decimal
// string, dates are ISO 8601. The caller seals the JSON with the user's DEK.

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** How long before tachyon expiry the token is refreshed (libgm RefreshTachyonBuffer). */
export const REFRESH_TACHYON_BUFFER_MS = 60 * 60 * 1000;

const DEFAULT_TACHYON_TTL_MICROS = 24n * 60n * 60n * 1_000_000n;

export type AuthData = {
  requestCrypto: AesCtrHelper;
  refreshKey: Jwk;
  browser: Device | null;
  mobile: Device | null;
  tachyonAuthToken: Uint8Array | null;
  tachyonExpiry: Date | null;
  tachyonTtlMicros: bigint;
  /** uuid, nil uuid by default (as in Go). */
  sessionId: string;
  /** Set for Google-account (Gaia) pairing: the phone's registration id. */
  destRegId: string | null;
  pairingId: string | null;
  /** Google account cookies (Gaia only). */
  cookies: Record<string, string> | null;
};

export class AuthDataParseError extends TaggedError("AuthDataParseError")<{
  field: string;
  message: string;
  cause?: unknown;
}> {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

const JsonSchema = z.object({
  v: z.literal(1),
  requestCrypto: z.object({ aesKey: z.string(), hmacKey: z.string() }),
  refreshKey: z.unknown(),
  browser: z.string().nullable(),
  mobile: z.string().nullable(),
  tachyonAuthToken: z.string().nullable(),
  tachyonExpiry: z.string().nullable(),
  tachyonTtlMicros: z.string(),
  sessionId: z.string(),
  destRegId: z.string().nullable(),
  pairingId: z.string().nullable(),
  cookies: z.record(z.string(), z.string()).nullable(),
});

type AuthDataJson = z.infer<typeof JsonSchema>;

const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const fieldError = (field: string, detail: string, cause?: unknown): AuthDataParseError =>
  new AuthDataParseError({
    field,
    message: `stored Google Messages session field "${field}" ${detail}; the session data is corrupt or from an incompatible version, so the phone must be re-paired`,
    cause,
  });

const decodeBase64 = (field: string, value: string): Result<Uint8Array, AuthDataParseError> =>
  STD_BASE64.test(value)
    ? Result.ok(new Uint8Array(Buffer.from(value, "base64")))
    : Result.err(fieldError(field, "is not padded standard base64"));

const decodeDevice = (field: string, value: string | null): Result<Device | null, AuthDataParseError> => {
  if (value === null) return Result.ok(null);
  const bytes = decodeBase64(field, value);
  if (bytes.isErr()) return Result.err(bytes.error);
  try {
    return Result.ok(fromBinary(DeviceSchema, bytes.value));
  } catch (cause) {
    return Result.err(fieldError(field, "is not a binary authentication.Device", cause));
  }
};

const decodeUuid = (field: string, value: string | null): Result<string | null, AuthDataParseError> => {
  if (value === null) return Result.ok(null);
  return UUID.test(value) ? Result.ok(value.toLowerCase()) : Result.err(fieldError(field, "is not a UUID"));
};

const encodeDevice = (device: Device | null): string | null =>
  device === null ? null : encode(toBinary(DeviceSchema, device));

export const AuthData = {
  /** Fresh request crypto + refresh key (libgm NewAuthData). */
  createForPairing(): AuthData {
    return {
      requestCrypto: AesCtrHelper.generate(),
      refreshKey: Jwk.generate(),
      browser: null,
      mobile: null,
      tachyonAuthToken: null,
      tachyonExpiry: null,
      tachyonTtlMicros: 0n,
      sessionId: NIL_UUID,
      destRegId: null,
      pairingId: null,
      cookies: null,
    };
  },

  /** libgm IsGoogleAccount: a destination registration id is set. */
  isGoogleAccount(a: AuthData): boolean {
    return a.destRegId !== null;
  },

  /**
   * libgm (fork) HasCookies: true for QR sessions, and for Gaia sessions when
   * cookies are set. libgm uses it to pick the Google endpoint variants and to
   * ignore unencrypted intermediate frames.
   */
  hasCookies(a: AuthData): boolean {
    return !AuthData.isGoogleAccount(a) || a.cookies !== null;
  },

  /** libgm IsLoggedIn: browser set and (non-Gaia or cookies set). */
  isLoggedIn(a: AuthData): boolean {
    return a.browser !== null && AuthData.hasCookies(a);
  },

  /** libgm AuthNetwork: "GDitto" for Gaia sessions, "" otherwise. */
  authNetwork(a: AuthData): string {
    return AuthData.isGoogleAccount(a) ? GOOGLE_NETWORK : "";
  },

  /** True when the token is missing an expiry or expires within REFRESH_TACHYON_BUFFER_MS of `now`. */
  needsTokenRefresh(a: AuthData, now: Date): boolean {
    return a.tachyonExpiry === null || a.tachyonExpiry.getTime() - now.getTime() <= REFRESH_TACHYON_BUFFER_MS;
  },

  /** libgm updateTachyonAuthToken: TTL 0 means 24 h. */
  applyTokenData(a: AuthData, token: Uint8Array, ttlMicros: bigint, now: Date): void {
    const ttl = ttlMicros === 0n ? DEFAULT_TACHYON_TTL_MICROS : ttlMicros;
    a.tachyonAuthToken = token;
    a.tachyonTtlMicros = ttl;
    a.tachyonExpiry = new Date(now.getTime() + Number(ttl / 1000n));
  },

  serialize(a: AuthData): string {
    const json: AuthDataJson = {
      v: 1,
      requestCrypto: { aesKey: encode(a.requestCrypto.aesKey), hmacKey: encode(a.requestCrypto.hmacKey) },
      refreshKey: Jwk.toJson(a.refreshKey),
      browser: encodeDevice(a.browser),
      mobile: encodeDevice(a.mobile),
      tachyonAuthToken: a.tachyonAuthToken === null ? null : encode(a.tachyonAuthToken),
      tachyonExpiry: a.tachyonExpiry === null ? null : a.tachyonExpiry.toISOString(),
      tachyonTtlMicros: a.tachyonTtlMicros.toString(),
      sessionId: a.sessionId,
      destRegId: a.destRegId,
      pairingId: a.pairingId,
      cookies: a.cookies === null ? null : { ...a.cookies },
    };
    return JSON.stringify(json);
  },

  parse(json: string): Result<AuthData, AuthDataParseError> {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      // The SyntaxError quotes input text, which holds secrets.
      return Result.err(fieldError("(root)", "is not valid JSON"));
    }
    const shape = JsonSchema.safeParse(raw);
    if (!shape.success) {
      const issue = shape.error.issues[0];
      const field = issue === undefined || issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return Result.err(fieldError(field, `is missing or has the wrong type (${issue?.code ?? "invalid"})`));
    }
    const j = shape.data;
    return Result.gen(function* () {
      const aesKey = yield* decodeBase64("requestCrypto.aesKey", j.requestCrypto.aesKey);
      const hmacKey = yield* decodeBase64("requestCrypto.hmacKey", j.requestCrypto.hmacKey);
      const requestCrypto = yield* AesCtrHelper.fromKeys(aesKey, hmacKey).mapError((cause) =>
        fieldError("requestCrypto", `has a key of the wrong length (${cause.key})`, cause),
      );
      const refreshKey = yield* Jwk.fromJson(j.refreshKey).mapError((cause) =>
        fieldError(`refreshKey.${cause.field}`, "is invalid", cause),
      );
      const browser = yield* decodeDevice("browser", j.browser);
      const mobile = yield* decodeDevice("mobile", j.mobile);
      const tachyonAuthToken =
        j.tachyonAuthToken === null ? null : yield* decodeBase64("tachyonAuthToken", j.tachyonAuthToken);
      let tachyonExpiry: Date | null = null;
      if (j.tachyonExpiry !== null) {
        const date = new Date(j.tachyonExpiry);
        if (Number.isNaN(date.getTime())) return Result.err(fieldError("tachyonExpiry", "is not an ISO 8601 date"));
        tachyonExpiry = date;
      }
      if (!DECIMAL.test(j.tachyonTtlMicros)) {
        return Result.err(fieldError("tachyonTtlMicros", "is not a non-negative decimal integer"));
      }
      const sessionId = yield* decodeUuid("sessionId", j.sessionId);
      const destRegId = yield* decodeUuid("destRegId", j.destRegId);
      const pairingId = yield* decodeUuid("pairingId", j.pairingId);
      return Result.ok({
        requestCrypto,
        refreshKey,
        browser,
        mobile,
        tachyonAuthToken,
        tachyonExpiry,
        tachyonTtlMicros: BigInt(j.tachyonTtlMicros),
        sessionId: sessionId ?? NIL_UUID,
        // libgm treats the nil UUID as "not a Google account".
        destRegId: destRegId === NIL_UUID ? null : destRegId,
        pairingId: pairingId === NIL_UUID ? null : pairingId,
        cookies: j.cookies === null ? null : { ...j.cookies },
      });
    });
  },
} as const;
