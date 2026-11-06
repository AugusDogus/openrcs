/**
 * libgm constants: endpoint URLs (util/paths.go), client identity
 * (util/constants.go, util/config.go), content types (http.go) and request
 * header builders (util/func.go). Values must stay in sync with libgm; the
 * test checks them against fixtures generated from the Go source.
 */
import { create } from "@bufbuild/protobuf";

import {
  BrowserDetailsSchema,
  BrowserType,
  ConfigVersionSchema,
  DeviceType,
  type BrowserDetails,
  type ConfigVersion,
} from "@/gen/gmproto/authentication_pb";

// util/constants.go
export const GOOGLE_API_KEY = "AIzaSyCA4RsOZUFrm9whhtGosPlJLmVPnfSHKz8";
export const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
export const SEC_UA = `"Google Chrome";v="146", "Chromium";v="146", "Not-A.Brand";v="24"`;
export const UA_PLATFORM = "Android";
export const X_USER_AGENT = "grpc-web-javascript/0.1";
export const QR_CODE_URL_BASE =
  "https://support.google.com/messages/?p=web_computer#?c=";
export const SEC_UA_MOBILE = "?1";

// util/config.go
/** AuthMessage.network for QR-paired sessions. */
export const QR_NETWORK = "Bugle";
/** AuthMessage.network for Google-account (Gaia) paired sessions. */
export const GOOGLE_NETWORK = "GDitto";

/** libgm `util.ConfigMessage`: the Messages for web version libgm claims. */
export function configVersion(): ConfigVersion {
  return create(ConfigVersionSchema, {
    Year: 2026,
    Month: 3,
    Day: 18,
    V1: 4,
    V2: 6,
  });
}

/** libgm `util.BrowserDetailsMessage`. */
export function browserDetails(): BrowserDetails {
  return create(BrowserDetailsSchema, {
    userAgent: USER_AGENT,
    browserType: BrowserType.OTHER,
    OS: "libgm",
    deviceType: DeviceType.TABLET,
  });
}

// http.go
export const CONTENT_TYPE_PROTOBUF = "application/x-protobuf";
export const CONTENT_TYPE_PBLITE = "application/json+protobuf";

// util/paths.go
export const MESSAGES_BASE_URL = "https://messages.google.com";

export const GOOGLE_AUTHENTICATION_URL = `${MESSAGES_BASE_URL}/web/authentication`;
export const GOOGLE_TIMESOURCE_URL = `${MESSAGES_BASE_URL}/web/timesource`;

const INSTANT_MESSAGING_BASE_URL = "https://instantmessaging-pa.googleapis.com";
const INSTANT_MESSAGING_BASE_URL_GOOGLE =
  "https://instantmessaging-pa.clients6.google.com";

export const UPLOAD_MEDIA_URL = `${INSTANT_MESSAGING_BASE_URL}/upload`;

const PAIRING_BASE_URL = `${INSTANT_MESSAGING_BASE_URL}/$rpc/google.internal.communications.instantmessaging.v1.Pairing`;
export const REGISTER_PHONE_RELAY_URL = `${PAIRING_BASE_URL}/RegisterPhoneRelay`;
export const REFRESH_PHONE_RELAY_URL = `${PAIRING_BASE_URL}/RefreshPhoneRelay`;
export const GET_WEB_ENCRYPTION_KEY_URL = `${PAIRING_BASE_URL}/GetWebEncryptionKey`;
export const REVOKE_RELAY_PAIRING_URL = `${PAIRING_BASE_URL}/RevokeRelayPairing`;

const MESSAGING_BASE_URL = `${INSTANT_MESSAGING_BASE_URL}/$rpc/google.internal.communications.instantmessaging.v1.Messaging`;
const MESSAGING_BASE_URL_GOOGLE = `${INSTANT_MESSAGING_BASE_URL_GOOGLE}/$rpc/google.internal.communications.instantmessaging.v1.Messaging`;
export const RECEIVE_MESSAGES_URL = `${MESSAGING_BASE_URL}/ReceiveMessages`;
export const SEND_MESSAGE_URL = `${MESSAGING_BASE_URL}/SendMessage`;
export const ACK_MESSAGES_URL = `${MESSAGING_BASE_URL}/AckMessages`;
export const RECEIVE_MESSAGES_URL_GOOGLE = `${MESSAGING_BASE_URL_GOOGLE}/ReceiveMessages`;
export const SEND_MESSAGE_URL_GOOGLE = `${MESSAGING_BASE_URL_GOOGLE}/SendMessage`;
export const ACK_MESSAGES_URL_GOOGLE = `${MESSAGING_BASE_URL_GOOGLE}/AckMessages`;

const REGISTRATION_BASE_URL = `${INSTANT_MESSAGING_BASE_URL_GOOGLE}/$rpc/google.internal.communications.instantmessaging.v1.Registration`;
export const SIGN_IN_GAIA_URL = `${REGISTRATION_BASE_URL}/SignInGaia`;
export const REGISTER_REFRESH_URL = `${REGISTRATION_BASE_URL}/RegisterRefresh`;

export const CONFIG_URL = "https://messages.google.com/web/config";

// util/func.go. Header names are lowercase, as sent over HTTP/2.

/** Request headers as a plain record, ready for `fetch` or `new Headers()`. */
export type HeaderRecord = Record<string, string>;

const SEC_UA_PLATFORM = `"${UA_PLATFORM}"`;

/**
 * libgm `BuildRelayHeaders`, used for every API request. An empty or missing
 * `contentType` omits the content-type header.
 */
export function relayHeaders(
  contentType: string | undefined,
  accept: string,
): HeaderRecord {
  const headers: HeaderRecord = {
    "sec-ch-ua": SEC_UA,
    "x-user-agent": X_USER_AGENT,
    "x-goog-api-key": GOOGLE_API_KEY,
  };
  if (contentType) headers["content-type"] = contentType;
  headers["sec-ch-ua-mobile"] = SEC_UA_MOBILE;
  headers["user-agent"] = USER_AGENT;
  headers["sec-ch-ua-platform"] = SEC_UA_PLATFORM;
  headers.accept = accept;
  headers.origin = MESSAGES_BASE_URL;
  headers["sec-fetch-site"] = "cross-site";
  headers["sec-fetch-mode"] = "cors";
  headers["sec-fetch-dest"] = "empty";
  headers.referer = `${MESSAGES_BASE_URL}/`;
  headers["accept-language"] = "en-US,en;q=0.9";
  return headers;
}

/**
 * Headers libgm's `fetchConfig` sends to CONFIG_URL: relay headers without a
 * body, minus x-user-agent and origin, with sec-fetch-site same-origin.
 */
export function configHeaders(): HeaderRecord {
  const headers = relayHeaders(undefined, "*/*");
  headers["sec-fetch-site"] = "same-origin";
  delete headers["x-user-agent"];
  delete headers.origin;
  return headers;
}

/** libgm `BuildUploadHeaders`, used to download media from UPLOAD_MEDIA_URL. */
export function uploadHeaders(downloadMetadata: string): HeaderRecord {
  return {
    "x-goog-download-metadata": downloadMetadata,
    "sec-ch-ua": SEC_UA,
    "sec-ch-ua-mobile": SEC_UA_MOBILE,
    "user-agent": USER_AGENT,
    "sec-ch-ua-platform": SEC_UA_PLATFORM,
    accept: "*/*",
    origin: MESSAGES_BASE_URL,
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: `${MESSAGES_BASE_URL}/`,
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "en-US,en;q=0.9",
  };
}

/** Arguments of libgm `NewMediaUploadHeaders`; missing or empty values are omitted. */
export type MediaUploadHeaderOptions = {
  imageSize: string;
  command?: string;
  uploadOffset?: string;
  imageContentType?: string;
  protocol?: string;
};

/** libgm `NewMediaUploadHeaders`, used for resumable uploads to UPLOAD_MEDIA_URL. */
export function mediaUploadHeaders(
  options: MediaUploadHeaderOptions,
): HeaderRecord {
  const headers: HeaderRecord = { "sec-ch-ua": SEC_UA };
  if (options.protocol) headers["x-goog-upload-protocol"] = options.protocol;
  headers["x-goog-upload-header-content-length"] = options.imageSize;
  headers["sec-ch-ua-mobile"] = SEC_UA_MOBILE;
  headers["user-agent"] = USER_AGENT;
  if (options.imageContentType) {
    headers["x-goog-upload-header-content-type"] = options.imageContentType;
  }
  headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  if (options.command) headers["x-goog-upload-command"] = options.command;
  if (options.uploadOffset) headers["x-goog-upload-offset"] = options.uploadOffset;
  headers["sec-ch-ua-platform"] = SEC_UA_PLATFORM;
  headers.accept = "*/*";
  headers.origin = MESSAGES_BASE_URL;
  headers["sec-fetch-site"] = "cross-site";
  headers["sec-fetch-mode"] = "cors";
  headers["sec-fetch-dest"] = "empty";
  headers.referer = `${MESSAGES_BASE_URL}/`;
  headers["accept-encoding"] = "gzip, deflate, br";
  headers["accept-language"] = "en-US,en;q=0.9";
  return headers;
}
