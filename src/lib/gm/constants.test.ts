import { describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";

import {
  BrowserDetailsSchema,
  ConfigVersionSchema,
} from "@/gen/gmproto/authentication_pb";

import fixtures from "./__fixtures__/pblite-constants.json";
import * as C from "./constants";

describe("header builders match libgm", () => {
  test("relayHeaders with pblite body", () => {
    expect(C.relayHeaders(C.CONTENT_TYPE_PBLITE, "*/*")).toEqual(
      fixtures.relayHeadersPblite,
    );
  });

  test("relayHeaders with protobuf body", () => {
    expect(C.relayHeaders(C.CONTENT_TYPE_PROTOBUF, "*/*")).toEqual(
      fixtures.relayHeadersProtobuf,
    );
  });

  test("relayHeaders without a body omits content-type", () => {
    expect(C.relayHeaders(undefined, "*/*")).toEqual(fixtures.relayHeadersNoBody);
    expect(C.relayHeaders("", "*/*")).toEqual(fixtures.relayHeadersNoBody);
  });

  test("configHeaders matches fetchConfig", () => {
    expect(C.configHeaders()).toEqual(fixtures.configHeaders);
  });

  test("uploadHeaders", () => {
    expect(C.uploadHeaders("bWV0YWRhdGE=")).toEqual(fixtures.uploadHeaders);
  });

  test("mediaUploadHeaders for a resumable start", () => {
    expect(
      C.mediaUploadHeaders({
        imageSize: "12345",
        command: "start",
        imageContentType: "image/jpeg",
        protocol: "resumable",
      }),
    ).toEqual(fixtures.mediaUploadStartHeaders);
  });

  test("mediaUploadHeaders for upload and finalize", () => {
    expect(
      C.mediaUploadHeaders({
        imageSize: "12345",
        command: "upload, finalize",
        uploadOffset: "0",
        imageContentType: "image/jpeg",
        protocol: "",
      }),
    ).toEqual(fixtures.mediaUploadFinalizeHeaders);
  });
});

describe("messages match libgm", () => {
  test("configVersion is util.ConfigMessage", () => {
    expect(base64Encode(toBinary(ConfigVersionSchema, C.configVersion()))).toBe(
      fixtures.configVersionBinaryBase64,
    );
  });

  test("browserDetails is util.BrowserDetailsMessage", () => {
    expect(base64Encode(toBinary(BrowserDetailsSchema, C.browserDetails()))).toBe(
      fixtures.browserDetailsBinaryBase64,
    );
  });

  test("factories return independent messages", () => {
    const a = C.configVersion();
    a.Year = 1999;
    expect(C.configVersion().Year).toBe(2026);
  });
});

test("string constants match libgm", () => {
  const go = fixtures.strings;
  expect({
    GoogleAPIKey: C.GOOGLE_API_KEY,
    UserAgent: C.USER_AGENT,
    SecUA: C.SEC_UA,
    UAPlatform: C.UA_PLATFORM,
    XUserAgent: C.X_USER_AGENT,
    QRCodeURLBase: C.QR_CODE_URL_BASE,
    SecUAMobile: C.SEC_UA_MOBILE,
    QRNetwork: C.QR_NETWORK,
    GoogleNetwork: C.GOOGLE_NETWORK,
    MessagesBaseURL: C.MESSAGES_BASE_URL,
    GoogleAuthenticationURL: C.GOOGLE_AUTHENTICATION_URL,
    GoogleTimesourceURL: C.GOOGLE_TIMESOURCE_URL,
    UploadMediaURL: C.UPLOAD_MEDIA_URL,
    RegisterPhoneRelayURL: C.REGISTER_PHONE_RELAY_URL,
    RefreshPhoneRelayURL: C.REFRESH_PHONE_RELAY_URL,
    GetWebEncryptionKeyURL: C.GET_WEB_ENCRYPTION_KEY_URL,
    RevokeRelayPairingURL: C.REVOKE_RELAY_PAIRING_URL,
    ReceiveMessagesURL: C.RECEIVE_MESSAGES_URL,
    SendMessageURL: C.SEND_MESSAGE_URL,
    AckMessagesURL: C.ACK_MESSAGES_URL,
    ReceiveMessagesURLGoogle: C.RECEIVE_MESSAGES_URL_GOOGLE,
    SendMessageURLGoogle: C.SEND_MESSAGE_URL_GOOGLE,
    AckMessagesURLGoogle: C.ACK_MESSAGES_URL_GOOGLE,
    SignInGaiaURL: C.SIGN_IN_GAIA_URL,
    RegisterRefreshURL: C.REGISTER_REFRESH_URL,
    ConfigURL: C.CONFIG_URL,
  }).toEqual(go);
});
