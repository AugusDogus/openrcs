import { createHash } from "node:crypto";

/**
 * Google `Authorization` header value for cookie auth, as libgm's
 * `SAPISIDHash`: "SAPISIDHASH <ts>_<hex(sha1("<ts> <sapisid> <origin>"))>".
 * `unixSeconds` must be an integer (Go formats an int64).
 */
export const sapisidHash = (
  origin: string,
  sapisid: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): string => {
  const ts = Math.trunc(unixSeconds).toString();
  const digest = createHash("sha1").update(`${ts} ${sapisid} ${origin}`, "utf8").digest("hex");
  return `SAPISIDHASH ${ts}_${digest}`;
};
