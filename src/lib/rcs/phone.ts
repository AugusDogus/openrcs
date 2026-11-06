import { Result } from "better-result";
import type { Database } from "@/lib/db/client";
import { GMClient, type GMClientOptions, type GMEvent } from "@/lib/gm/client";
import {
  GMConversation,
  GMMessage,
  type PlainConversation,
  type PlainMessage,
} from "@/lib/gm/message";
import type { RcsContext } from "./context";
import {
  describeForLog,
  GmFailure,
  RcsAbortedError,
  RcsNeedsRepairError,
  type RcsPhoneAccessError,
} from "./errors";
import { DEFAULT_LEASE_TTL_MS, PhoneLease, type AcquireOptions } from "./phone-lease";
import { SessionStore, type SessionSignal } from "./session-store";
import { Store } from "./store";

/**
 * Runs one unit of work against the user's phone inside a single function
 * invocation (docs/architecture.md "Serverless model"):
 *
 *   lease -> load session (must be paired) -> GMClient.create (buffering
 *   message/conversation events, tracking AuthData changes) -> connect ->
 *   fn(client) -> optional waitForQuiet -> store buffered events -> close ->
 *   persist AuthData if it changed (also on failure) -> record
 *   last_connected_at / last_error / status -> release lease.
 */
export type WithPhoneOptions = {
  /** Short name for logs and recorded errors, e.g. "sync" or "send". */
  readonly operation?: string;
  readonly signal?: AbortSignal;
  /** Drain queued updates after `fn` succeeds (sync, send echo). */
  readonly waitForQuiet?: { readonly quietMs: number; readonly maxMs: number };
  /** Lease acquisition options, or a lease the caller already holds (it is neither renewed nor released here). */
  readonly lease?: AcquireOptions | { readonly held: PhoneLease };
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Injectable for tests; defaults to `GMClient.create`. */
  readonly createClient?: (options: GMClientOptions) => GMClient;
};

/** Anything tagged that `fn` may fail with (GM errors or service-layer errors). */
type TaggedFailure = { readonly _tag: string; readonly message: string };

const isHeldLease = (
  lease: WithPhoneOptions["lease"],
): lease is { readonly held: PhoneLease } => lease !== undefined && "held" in lease;

const log = (level: "warn" | "error", text: string) => console[level](`[rcs:phone] ${text}`);

/** Message/conversation events seen on the long poll, last write wins per id. */
class EventBuffer {
  readonly messages = new Map<string, PlainMessage>();
  readonly conversations = new Map<string, PlainConversation>();

  add(event: GMEvent): void {
    if (event.type === "message") {
      const plain = GMMessage.toPlain(event.message);
      this.messages.set(plain.messageId, plain);
    } else if (event.type === "conversation") {
      const plain = GMConversation.toPlain(event.conversation);
      this.conversations.set(plain.conversationId, plain);
    }
  }
}

/** Whether a failure from `fn` means the session is dead. */
const failureNeedsRepair = (error: TaggedFailure): boolean =>
  "needsRepair" in error && typeof error.needsRepair === "boolean"
    ? error.needsRepair
    : GmFailure.needsRepair(error);

/** Only phone/Google failures are recorded as the session's last error. */
const isPhoneFailure = (error: TaggedFailure): boolean =>
  error._tag === "RcsPhoneError" || error._tag.startsWith("GM");

/**
 * Non-secret fields of a failure for logs: tag, HTTP status, action, the
 * auth-expiry reason and Google's own error text. Never cookies, tokens or
 * message content (src/lib/gm errors do not carry them).
 */
const diagnose = (error: TaggedFailure): string => {
  const parts = [`tag=${error._tag}`];
  const field = (name: string) => (name in error ? Reflect.get(error, name) : undefined);
  for (const name of ["gmTag", "status", "reason", "action", "errorType", "googleMessage"]) {
    const value = field(name);
    if (typeof value === "string" || typeof value === "number") parts.push(`${name}=${value}`);
  }
  return parts.join(" ");
};

/** Plain-language text for any error a phone-backed operation can return. */
export const describePhoneError = (error: TaggedFailure): string =>
  error._tag.startsWith("GM") ? GmFailure.describe(error) : error.message;

const storeEvents = async (db: Database, ctx: RcsContext, events: EventBuffer) => {
  if (events.conversations.size > 0) {
    const stored = await Store.upsertConversations(db, ctx, [...events.conversations.values()]);
    if (stored.isErr()) log("error", `storing conversation events failed: ${describeForLog(stored.error)}`);
  }
  if (events.messages.size > 0) {
    const stored = await Store.upsertMessages(db, ctx, [...events.messages.values()]);
    if (stored.isErr()) log("error", `storing message events failed: ${describeForLog(stored.error)}`);
  }
};

const runConnected = async <T, E extends TaggedFailure>(
  db: Database,
  ctx: RcsContext,
  fn: (client: GMClient) => Promise<Result<T, E>>,
  opts: WithPhoneOptions,
  operation: string,
): Promise<Result<T, E | RcsPhoneAccessError>> => {
  const loaded = await SessionStore.load(db, ctx);
  if (loaded.isErr()) return Result.err(loaded.error);
  const session = loaded.value;
  if (session.status !== "paired") {
    return Result.err(
      new RcsNeedsRepairError({
        userId: ctx.userId,
        reason: session.lastError ?? session.status,
        message: GmFailure.repairMessage,
      }),
    );
  }

  const events = new EventBuffer();
  // Mutated from the event callback, so kept in an object TS does not narrow.
  const seen: { authDirty: boolean; fatal: SessionSignal | null; diagnosis: string | null } = {
    authDirty: false,
    fatal: null,
    diagnosis: null,
  };
  const client = (opts.createClient ?? GMClient.create)({
    authData: session.authData,
    fetch: opts.fetch,
    requestTimeoutMs: opts.requestTimeoutMs,
    onEvent: (event) => {
      switch (event.type) {
        case "message":
        case "conversation":
          events.add(event);
          break;
        case "authDataChanged":
          seen.authDirty = true;
          break;
        case "gaiaLoggedOut":
          seen.fatal = { type: "gaiaLoggedOut", error: GmFailure.repairMessage };
          seen.diagnosis = "event=gaiaLoggedOut (logged-out frame on GET_UPDATES)";
          break;
        case "listenFatal":
          seen.fatal = { type: "listenFatal", error: GmFailure.repairMessage };
          seen.diagnosis = `event=listenFatal ${diagnose(event.error)}`;
          break;
        default:
          break;
      }
    },
  });

  let outcome: SessionSignal;
  let result: Result<T, E | RcsPhoneAccessError>;
  try {
    const connected = await client.connect({ signal: opts.signal });
    if (connected.isErr()) {
      const phoneError = GmFailure.toPhoneError(ctx.userId, `${operation}.connect`, connected.error);
      seen.diagnosis ??= `stage=connect ${diagnose(connected.error)}`;
      outcome = phoneError.needsRepair
        ? { type: "authExpired", error: phoneError.message }
        : { type: "failed", error: phoneError.message };
      result = Result.err(phoneError);
    } else {
      const value = await fn(client);
      if (value.isErr()) {
        const error = value.error;
        seen.diagnosis ??= `stage=${operation} ${diagnose(error)}`;
        outcome = failureNeedsRepair(error)
          ? { type: "authExpired", error: describePhoneError(error) }
          : { type: "connected", error: isPhoneFailure(error) ? describePhoneError(error) : null };
      } else {
        outcome = { type: "connected", error: null };
        if (opts.waitForQuiet) await client.waitForQuiet(opts.waitForQuiet);
      }
      result = value;
    }
  } finally {
    await storeEvents(db, ctx, events);
    await client.close();
    if (seen.authDirty) {
      const saved = await SessionStore.saveAuthData(db, ctx, client.authData);
      if (saved.isErr()) {
        log("error", `persisting refreshed AuthData failed: ${describeForLog(saved.error)}`);
      }
    }
  }

  const signal: SessionSignal = seen.fatal ?? outcome;
  if (signal.type !== "connected" || signal.error !== null) {
    log("warn", `${operation} for user ${ctx.userId} ended with ${signal.type}: ${seen.diagnosis ?? "no diagnosis"}`);
  }
  const recorded = await SessionStore.record(db, ctx.userId, signal);
  if (recorded.isErr()) log("warn", `recording session outcome failed: ${describeForLog(recorded.error)}`);
  return result;
};

/**
 * Run `fn` with a connected client. `fn` returns a Result; its error type is
 * preserved alongside the access errors (lease busy, not paired, needs
 * re-pair, stale key, phone unreachable). Map any of them to text with
 * `describePhoneError`.
 */
export const withPhone = async <T, E extends TaggedFailure>(
  db: Database,
  ctx: RcsContext,
  fn: (client: GMClient) => Promise<Result<T, E>>,
  opts: WithPhoneOptions = {},
): Promise<Result<T, E | RcsPhoneAccessError>> => {
  const operation = opts.operation ?? "phone";
  if (opts.signal?.aborted) {
    return Result.err(
      new RcsAbortedError({
        userId: ctx.userId,
        operation,
        message: "The request was cancelled before openrcs contacted your phone. Nothing was changed.",
      }),
    );
  }
  if (isHeldLease(opts.lease)) return runConnected(db, ctx, fn, opts, operation);

  const ttlMs = opts.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const acquired = await PhoneLease.acquire(db, ctx.userId, {
    ...opts.lease,
    ttlMs,
    signal: opts.signal ?? opts.lease?.signal,
  });
  if (acquired.isErr()) return Result.err(acquired.error);
  const lease = acquired.value;
  const stopKeepAlive = PhoneLease.keepAlive(db, lease, {
    ttlMs,
    onLost: (error) => log("warn", `lease renewal failed: ${describeForLog(error)}`),
  });
  try {
    return await runConnected(db, ctx, fn, opts, operation);
  } finally {
    stopKeepAlive();
    const released = await PhoneLease.release(db, lease);
    if (released.isErr()) log("warn", `lease release failed: ${describeForLog(released.error)}`);
  }
};

export const Phone = { withPhone, describeError: describePhoneError } as const;
