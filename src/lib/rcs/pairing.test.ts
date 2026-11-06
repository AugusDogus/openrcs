import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { AuthData } from "@/lib/gm/auth-data";
import type { QrPairingError } from "@/lib/gm/errors";
import type { QrPairingAttempt } from "@/lib/gm/pair-qr";
import { pairWithQr, type QrPairingDeps } from "./pairing";
import type { PairingEvent } from "./pairing-event";

const QR_URL = "https://support.google.com/messages/?p=web_computer#qr/";

describe("pairWithQr", () => {
  test("a QR refresh that finishes after the phone paired emits no stale QR code", async () => {
    const attempt: QrPairingAttempt = { kind: "qrPairingAttempt", id: "attempt-1" };
    const refreshStarted = Promise.withResolvers<void>();
    const refreshResult = Promise.withResolvers<Result<string, QrPairingError>>();
    let cancelled = 0;
    const pairing: QrPairingDeps["pairing"] = {
      start: async () => Result.ok({ qrUrl: `${QR_URL}first`, attempt }),
      refresh: async () => {
        refreshStarted.resolve();
        return refreshResult.promise;
      },
      // The phone scans while the first refresh is still in flight.
      waitForPair: async () => {
        await refreshStarted.promise;
        return Result.ok({ authData: AuthData.createForPairing(), phoneId: "phone-1" });
      },
      cancel: async () => {
        cancelled += 1;
      },
    };
    const events: PairingEvent[] = [];

    const paired = await pairWithQr((event) => events.push(event), new AbortController().signal, {
      pairing,
      refreshMs: 5,
      refreshes: 3,
    });
    expect(paired.isOk()).toBe(true);
    const qrBefore = events.filter((event) => event.type === "qr").length;

    refreshResult.resolve(Result.ok(`${QR_URL}second`));
    await Bun.sleep(100);

    expect(qrBefore).toBe(1);
    expect(events.filter((event) => event.type === "qr")).toHaveLength(1);
    expect(cancelled).toBe(0);
  });
});
