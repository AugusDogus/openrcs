import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ListConversationsRequest_Folder } from "@/gen/gmproto/client_pb";
import { ActionType } from "@/gen/gmproto/rpc_pb";

import { AuthData } from "./auth-data";
import { GMClient, type GMTiming } from "./client";
import { QR_CODE_URL_BASE } from "./constants";
import { GaiaPairing, type PairingTiming } from "./pair-gaia";
import { QrPairing } from "./pair-qr";
import { CountingClock } from "./testing/counting-clock";
import { FakeGoogle, type FakeGoogle as FakeGoogleType } from "./testing/fake-google";
import { FakePhone, sampleConversation } from "./testing/fake-phone";

const TIMING: Partial<GMTiming & PairingTiming> = {
  startupAckWaitMs: 100,
  postAckDelayMs: 5,
  ackIntervalMs: 50,
  reconnectBackoffMs: [10],
  qrSettleMs: 20,
  gaiaInitTimeoutMs: 300,
};

const COOKIES = { SID: "sid", HSID: "hsid", SSID: "ssid", APISID: "apisid", SAPISID: "sapisid/x", OSID: "osid" };

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

let google: FakeGoogleType;
let clock: CountingClock;

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  // An unpaired phone: it learns the keys from the pairing itself.
  google = FakeGoogle.create({ phone: FakePhone.create({ paired: false }), seed: 11 });
  google.phone.conversations.push(sampleConversation("c1", "+15550000002"));
  clock = CountingClock.create();
});

afterEach(() => {
  expect(clock.pending()).toBe(0);
  google.shutdown();
  process.off("unhandledRejection", onUnhandled);
  expect(google.errors).toEqual([]);
  expect(unhandled).toEqual([]);
});

const testing = (): { readonly timing: typeof TIMING; readonly clock: CountingClock } => ({ timing: TIMING, clock });

/** The paired session must work: connect a client and list conversations through the fake phone. */
const expectUsable = async (authData: AuthData): Promise<void> => {
  const client = GMClient.create({ authData, fetch: google.fetch, testing: { timing: TIMING, clock } });
  expect((await client.connect()).isOk()).toBe(true);
  const listed = await client.listConversations({ count: 5, folder: ListConversationsRequest_Folder.INBOX });
  expect(listed.unwrap().conversations.map((c) => c.conversationID)).toEqual(["c1"]);
  await client.close();
};

describe("GaiaPairing (fake Google + UKEY2 server)", () => {
  const start = (): ReturnType<typeof GaiaPairing.start> => GaiaPairing.start({ cookies: COOKIES, fetch: google.fetch, testing: testing() });

  test("success: the emoji matches the phone's, keys are derived on both sides, and the session works", async () => {
    const started = (await start()).unwrap();
    expect(started.emojiImageUrl).toMatch(/^https:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/latest\/[0-9a-f_]+\/emoji\.svg$/);
    const finished = (await GaiaPairing.finish(started.attempt)).unwrap();
    expect(google.phone.expectedEmoji).toBe(started.emoji);
    const auth = finished.authData;
    expect(AuthData.isGoogleAccount(auth)).toBe(true);
    expect(AuthData.isLoggedIn(auth)).toBe(true);
    expect(auth.destRegId).toBe(google.phone.regId);
    expect(auth.pairingId).toBe(started.attempt.id);
    expect(auth.mobile?.sourceID).toBe("fake-browser-source");
    expect(auth.browser?.sourceID).toBe("FAKE-BROWSER-SOURCE");
    expect(auth.cookies).toEqual(COOKIES);
    expect(auth.requestCrypto).toEqual(google.phone.crypto ?? { aesKey: new Uint8Array(), hmacKey: new Uint8Array() });
    expect(finished.phoneId).toBe("fake-browser-source/42");
    // Pairing requests carried the destination registration id and the 300 s TTL.
    const init = google.phone.received.find((r) => r.action === ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT);
    expect(init?.destRegIds).toEqual([google.phone.regId]);
    expect(init?.ttlMicros).toBe(300_000_000n);
    expect(init?.sessionId).toBe("");
    expect(google.phone.cancels).toBe(0);
    await expectUsable(auth);
  });

  test.each([
    ["wrongEmoji", "GaiaIncorrectEmojiError", null],
    ["cancel", "GaiaCancelledError", "phone"],
    ["notMe", "GaiaCancelledError", "notMe"],
  ] as const)("the phone answering %s gives %s", async (behavior, tag, reason) => {
    google.phone.gaiaBehavior = behavior;
    const started = (await start()).unwrap();
    const res = await GaiaPairing.finish(started.attempt);
    if (!res.isErr()) throw new Error("expected an error");
    expect(res.error._tag).toBe(tag);
    if (res.error._tag === "GaiaCancelledError") expect(res.error.reason).toBe(reason ?? "phone");
  });

  test("aborting the wait sends CANCEL_GAIA_PAIRING", async () => {
    google.phone.gaiaBehavior = "silent";
    const started = (await start()).unwrap();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const res = await GaiaPairing.finish(started.attempt, { signal: controller.signal });
    expect(res.isErr() && res.error._tag === "GaiaCancelledError" && res.error.reason).toBe("aborted");
    expect(google.phone.cancels).toBe(1);
    const cancel = google.phone.received.find((r) => r.action === ActionType.CANCEL_GAIA_PAIRING);
    expect(cancel?.requestId).toBe(started.attempt.id);
  });

  test("the confirm timeout cancels too", async () => {
    google.phone.gaiaBehavior = "silent";
    const started = (await start()).unwrap();
    const res = await GaiaPairing.finish(started.attempt, { timeoutMs: 40 });
    expect(res.isErr() && res.error._tag === "GaiaTimeoutError" && res.error.code).toBeNull();
    expect(google.phone.cancels).toBe(1);
  });

  test("finish() fails at once, and cancels, when the pairing long poll was lost after start", async () => {
    google.phone.gaiaBehavior = "silent";
    const started = (await start()).unwrap();
    google.failPolls(503, 10);
    google.endStreams();
    // TIMING allows one reconnect, so the poll gives up after its second failure.
    await google.until(() => google.requests.filter((r) => r.path.endsWith("/ReceiveMessages") && r.status === 503).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const t0 = Date.now();
    const res = await GaiaPairing.finish(started.attempt, { timeoutMs: 3_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
    expect(google.phone.received.some((r) => r.action === ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED)).toBe(false);
    expect(google.phone.cancels).toBe(1);
  });

  test("cancel() after start sends CANCEL_GAIA_PAIRING and the attempt cannot be finished", async () => {
    const started = (await start()).unwrap();
    await GaiaPairing.cancel(started.attempt);
    expect(google.phone.cancels).toBe(1);
    const res = await GaiaPairing.finish(started.attempt);
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
  });

  test("no CLIENT_INIT answer: GaiaInitTimeoutError (with the multiple-devices hint) and a cancel", async () => {
    google.gaiaDevices = "two";
    google.phone.override(ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT, () => []);
    const res = await start();
    expect(res.isErr() && res.error._tag === "GaiaInitTimeoutError" && res.error.multipleDevices).toBe(true);
    expect(google.phone.cancels).toBe(1);
    // With two candidates, the newest-seen one was chosen.
    const init = google.phone.received.find((r) => r.action === ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT);
    expect(init?.destRegIds).toEqual([google.phone.regId]);
  });

  test("no pairable phone: GaiaNoDevicesError", async () => {
    google.gaiaDevices = "none";
    const res = await start();
    expect(res.isErr() && res.error._tag).toBe("GaiaNoDevicesError");
  });

  test("rejected cookies: GMAuthExpiredError (cookiesRejected)", async () => {
    google.rejectCookies = true;
    const res = await start();
    expect(res.isErr() && res.error._tag === "GMAuthExpiredError" && res.error.reason).toBe("cookiesRejected");
  });
});

describe("QrPairing (fake Google + phone)", () => {
  test("success: refresh gives a new code, the phone scans, and the session works", async () => {
    const started = (await QrPairing.start({ fetch: google.fetch, testing: testing() })).unwrap();
    expect(started.qrUrl.startsWith(QR_CODE_URL_BASE)).toBe(true);
    const refreshed = (await QrPairing.refresh(started.attempt)).unwrap();
    expect(refreshed).not.toBe(started.qrUrl);
    const waiting = QrPairing.waitForPair(started.attempt);
    google.push(google.phone.scanQr(refreshed));
    const t0 = Date.now();
    const paired = (await waiting).unwrap();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15); // the settle delay
    expect(paired.phoneId).toBe("fake-phone-source");
    expect(AuthData.isLoggedIn(paired.authData)).toBe(true);
    expect(AuthData.isGoogleAccount(paired.authData)).toBe(false);
    expect(paired.authData.tachyonAuthToken).toEqual(google.phone.pairedToken);
    await expectUsable(paired.authData);
  });

  test("a scan that arrives before waitForPair is called is not lost", async () => {
    const started = (await QrPairing.start({ fetch: google.fetch, testing: testing() })).unwrap();
    google.push(google.phone.scanQr(started.qrUrl));
    // Let the client read the frame before anyone waits (pairing acks only flush on close, as in libgm).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await QrPairing.waitForPair(started.attempt)).isOk()).toBe(true);
  });

  test("no scan within the wait: QrPairingTimeoutError", async () => {
    const started = (await QrPairing.start({ fetch: google.fetch, testing: testing() })).unwrap();
    const res = await QrPairing.waitForPair(started.attempt, { timeoutMs: 40 });
    expect(res.isErr() && res.error._tag).toBe("QrPairingTimeoutError");
  });

  test("aborting the wait: QrPairingCancelledError; cancel() closes an attempt", async () => {
    const started = (await QrPairing.start({ fetch: google.fetch, testing: testing() })).unwrap();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const res = await QrPairing.waitForPair(started.attempt, { signal: controller.signal });
    expect(res.isErr() && res.error._tag).toBe("QrPairingCancelledError");
    const other = (await QrPairing.start({ fetch: google.fetch, testing: testing() })).unwrap();
    await QrPairing.cancel(other.attempt);
    expect((await QrPairing.refresh(other.attempt)).isErr()).toBe(true);
    expect(google.openStreams()).toBe(0);
  });
});
