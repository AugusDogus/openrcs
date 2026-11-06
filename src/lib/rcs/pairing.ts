import { Result } from "better-result";
import type { Database } from "@/lib/db/client";
import type { AuthData } from "@/lib/gm/auth-data";
import type { GoogleCookies } from "@/lib/gm/google-cookies";
import { GaiaPairing } from "@/lib/gm/pair-gaia";
import {
  PairingKeys,
  type PreparedPairingKey,
  type VaultLockedError,
  type VaultStorageError,
} from "@/lib/vault";
import { describeForLog, RcsPhoneBusyError, type RcsStorageError } from "./errors";
import { PairingEvent } from "./pairing-event";
import { describePhoneError } from "./phone";
import { PhoneLease } from "./phone-lease";
import { SessionStore } from "./session-store";
import { deleteUserData } from "./store";
import { backfill } from "./sync";

/**
 * Google-account (Gaia) pairing orchestration behind `POST /api/pair/gaia`.
 * Holds the phone lease for the whole flow, prepares the DEK (and device
 * cookie) before the stream starts, then streams PairingEvents:
 * emoji -> paired -> sync* -> done (or error at any point).
 */
export type PairingStart = {
  /** Send as Set-Cookie on the response (headers cannot change once the stream starts). */
  readonly setCookie: string | null;
  readonly stream: ReadableStream<Uint8Array>;
};

export const PAIRING_BUDGET = {
  /** How long the user has to tap the emoji. */
  waitForPhoneMs: 180_000,
  /** Backfill stops by this offset from the request start (route maxDuration is 300 s). */
  backfillDeadlineMs: 240_000,
  keepAliveMs: 15_000,
  leaseTtlMs: 60_000,
} as const;

type Tagged = { readonly _tag: string; readonly message: string };

/** Plain text for pairing failures (src/lib/gm GaiaPairingError). */
export const describePairingError = (error: Tagged): string => {
  switch (error._tag) {
    case "GaiaNoDevicesError":
      return "Google found no phone with Google Messages on this account. On your phone, open Google Messages, check it is signed in to the same Google account (Settings > Google account), then try again.";
    case "GaiaIncorrectEmojiError":
      return "The emoji tapped on the phone did not match. Start pairing again and tap the emoji shown here.";
    case "GaiaCancelledError":
      return "Pairing was cancelled. Start again if that was not intended.";
    case "GaiaTimeoutError":
      return "The phone did not confirm in time. Start pairing again and tap the emoji within a few minutes.";
    case "GaiaInitTimeoutError":
      return "multipleDevices" in error && error.multipleDevices === true
        ? "Your phone did not answer the pairing request. This Google account has several phones with Google Messages; make sure the one you want is online with Google Messages open, then try again."
        : "Your phone did not answer the pairing request. Make sure it is online and Google Messages is open, then try again.";
    case "GaiaPairingFailedError":
      return "Google Messages refused the pairing for an unknown reason. Try again in a few minutes; if it keeps failing, update Google Messages on your phone and try again.";
    case "GMAuthExpiredError":
      return "Google rejected these cookies (they may have expired, or that browser signed out). Copy a fresh request from messages.google.com and try again.";
    default:
      return describePhoneError(error);
  }
};

type Paired = { readonly authData: AuthData; readonly phoneId: string };

type Emit = (event: PairingEvent) => void;

const pairWithGaia = async (
  cookies: GoogleCookies,
  emit: Emit,
  signal: AbortSignal,
): Promise<Result<Paired, string>> => {
  const started = await GaiaPairing.start({ cookies, signal });
  if (started.isErr()) return Result.err(describePairingError(started.error));
  emit({ type: "emoji", emoji: started.value.emoji, emojiImageUrl: started.value.emojiImageUrl });
  const finished = await GaiaPairing.finish(started.value.attempt, {
    signal,
    timeoutMs: PAIRING_BUDGET.waitForPhoneMs,
  });
  return finished.isOk()
    ? Result.ok(finished.value)
    : Result.err(describePairingError(finished.error));
};

const runPairing = async (
  db: Database,
  prepared: PreparedPairingKey,
  cookies: GoogleCookies,
  emit: Emit,
  signal: AbortSignal,
  lease: PhoneLease,
  startedAt: number,
): Promise<void> => {
  const userId = prepared.userId;
  const paired = await pairWithGaia(cookies, emit, signal);
  if (paired.isErr()) return emit({ type: "error", message: paired.error });

  const committed = await PairingKeys.commit(db, prepared, {
    onKeyRotated: async () => {
      const deleted = await deleteUserData(db, userId);
      // The hook contract is Promise<void>: a rejection makes commit fail with VaultStorageError.
      if (deleted.isErr()) throw deleted.error;
    },
  });
  if (committed.isErr()) {
    console.error(`[rcs:pairing] key commit failed: ${describeForLog(committed.error)}`);
    return emit({
      type: "error",
      message:
        "Your phone confirmed, but openrcs could not save the encryption key for this browser. Nothing was stored; start pairing again.",
    });
  }

  const ctx = { userId, dek: prepared.dek };
  const saved = await SessionStore.save(db, ctx, {
    kind: "gaia",
    phoneLabel: SessionStore.phoneLabelFrom(paired.value.phoneId),
    authData: paired.value.authData,
  });
  if (saved.isErr()) {
    console.error(`[rcs:pairing] saving session failed: ${describeForLog(saved.error)}`);
    return emit({
      type: "error",
      message:
        "Your phone confirmed, but openrcs could not save the session. Start pairing again; the phone may list an extra web device you can remove.",
    });
  }
  emit({ type: "paired" });

  const synced = await backfill(db, ctx, {
    deadlineMs: startedAt + PAIRING_BUDGET.backfillDeadlineMs,
    signal,
    onProgress: (progress) => emit({ type: "sync", ...progress }),
    phone: { lease: { held: lease } },
  });
  if (synced.isErr()) {
    return emit({
      type: "error",
      message: `Your phone is paired, but the first sync stopped: ${describePhoneError(synced.error)} Messages will keep syncing when you use openrcs.`,
    });
  }
  emit({ type: "done" });
};

/**
 * Acquire the lease and prepare the key, then return the SSE stream that runs
 * the pairing. Fails fast (before any stream) when the phone is busy or the
 * vault cannot be read.
 */
export const startPairing = async (
  db: Database,
  opts: {
    readonly userId: string;
    readonly cookieHeader: string | null;
    readonly cookies: GoogleCookies;
    readonly signal: AbortSignal;
    readonly startedAt?: number;
  },
): Promise<
  Result<PairingStart, RcsPhoneBusyError | RcsStorageError | VaultLockedError | VaultStorageError>
> => {
  const startedAt = opts.startedAt ?? Date.now();
  const acquired = await PhoneLease.tryAcquire(db, opts.userId, { ttlMs: PAIRING_BUDGET.leaseTtlMs });
  if (acquired.isErr()) return Result.err(acquired.error);
  const lease = acquired.value;
  if (lease === null) {
    return Result.err(
      new RcsPhoneBusyError({
        userId: opts.userId,
        waitedMs: 0,
        message:
          "openrcs is already talking to your phone (a pairing, sync or send is in progress). Wait a minute and start pairing again.",
      }),
    );
  }
  const prepared = await PairingKeys.prepare(db, opts.userId, opts.cookieHeader, { mode: "pairing" });
  if (prepared.isErr()) {
    await PhoneLease.release(db, lease);
    return Result.err(prepared.error);
  }

  const aborter = new AbortController();
  const signal = AbortSignal.any([opts.signal, aborter.signal]);
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const emit: Emit = (event) => write(PairingEvent.encode(event));
      const ping = setInterval(() => write(PairingEvent.keepAlive), PAIRING_BUDGET.keepAliveMs);
      const stopKeepAlive = PhoneLease.keepAlive(db, lease, {
        ttlMs: PAIRING_BUDGET.leaseTtlMs,
        onLost: (error) => console.warn(`[rcs:pairing] lease renewal failed: ${describeForLog(error)}`),
      });
      void runPairing(db, prepared.value, opts.cookies, emit, signal, lease, startedAt)
        .catch((error: unknown) => {
          console.error(
            `[rcs:pairing] unexpected failure: ${error instanceof Error ? error.name : "unknown"}`,
          );
          emit({
            type: "error",
            message: "Pairing failed unexpectedly. Nothing else was changed; start pairing again.",
          });
        })
        .finally(async () => {
          clearInterval(ping);
          stopKeepAlive();
          const released = await PhoneLease.release(db, lease);
          if (released.isErr()) {
            console.warn(`[rcs:pairing] lease release failed: ${describeForLog(released.error)}`);
          }
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed by the client disconnecting.
            }
          }
        });
    },
    cancel() {
      closed = true;
      aborter.abort();
    },
  });

  return Result.ok({ setCookie: prepared.value.setCookie, stream });
};

/** Response headers for the pairing event stream. */
export const pairingResponseHeaders = (setCookie: string | null): Headers => {
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
  });
  if (setCookie !== null) headers.append("set-cookie", setCookie);
  return headers;
};
