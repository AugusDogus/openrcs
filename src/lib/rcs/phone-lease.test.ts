import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PhoneLease } from "./phone-lease";
import { RcsTesting, type RcsTestEnv } from "./testing";

let env: RcsTestEnv;

beforeEach(async () => {
  env = await RcsTesting.setup();
});

afterEach(async () => {
  await env.cleanup();
});

describe("PhoneLease", () => {
  test("only one of many concurrent attempts acquires the lease", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => PhoneLease.tryAcquire(env.db, env.userId, { ttlMs: 10_000 })),
    );
    const held = attempts.map((a) => a.unwrap()).filter((lease) => lease !== null);
    expect(held).toHaveLength(1);
    expect((await PhoneLease.isHeld(env.db, env.userId)).unwrap()).toBe(true);
  });

  test("leases are per user", async () => {
    const other = await RcsTesting.createUser(env.db);
    const a = (await PhoneLease.tryAcquire(env.db, env.userId)).unwrap();
    const b = (await PhoneLease.tryAcquire(env.db, other)).unwrap();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  test("an expired lease can be taken over; the old holder can no longer renew or release it", async () => {
    const clock = RcsTesting.clock();
    const first = (await PhoneLease.tryAcquire(env.db, env.userId, { ttlMs: 1_000, now: clock.now })).unwrap();
    if (first === null) throw new Error("expected the first lease");
    expect((await PhoneLease.tryAcquire(env.db, env.userId, { now: clock.now })).unwrap()).toBeNull();

    clock.advance(1_001);
    const second = (await PhoneLease.tryAcquire(env.db, env.userId, { ttlMs: 1_000, now: clock.now })).unwrap();
    if (second === null) throw new Error("expected the takeover to succeed");
    expect(second.holder).not.toBe(first.holder);

    const renewed = await PhoneLease.renew(env.db, first, { now: clock.now });
    expect(renewed.isErr() && renewed.error._tag).toBe("RcsLeaseLostError");
    expect((await PhoneLease.release(env.db, first)).isOk()).toBe(true);
    // Releasing someone else's lease is a no-op.
    expect((await PhoneLease.isHeld(env.db, env.userId, clock.now)).unwrap()).toBe(true);

    expect((await PhoneLease.renew(env.db, second, { ttlMs: 5_000, now: clock.now })).unwrap().expiresAt).toBe(
      clock.now() + 5_000,
    );
    await PhoneLease.release(env.db, second);
    expect((await PhoneLease.isHeld(env.db, env.userId, clock.now)).unwrap()).toBe(false);
  });

  test("acquire waits for the holder to release, so invocations serialize", async () => {
    const order: string[] = [];
    const run = async (name: string, workMs: number) => {
      const lease = (await PhoneLease.acquire(env.db, env.userId, { waitMs: 5_000, pollMs: 10 })).unwrap();
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, workMs));
      order.push(`${name}:end`);
      await PhoneLease.release(env.db, lease);
    };
    await Promise.all([run("a", 60), run("b", 10), run("c", 10)]);
    // Every start is immediately followed by its own end: no overlap.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.split(":")[0]).toBe(order[i + 1]?.split(":")[0]);
    }
    expect(order).toHaveLength(6);
  });

  test("acquire gives up after the bounded wait with a busy error", async () => {
    const held = (await PhoneLease.tryAcquire(env.db, env.userId, { ttlMs: 60_000 })).unwrap();
    expect(held).not.toBeNull();
    const started = Date.now();
    const result = await PhoneLease.acquire(env.db, env.userId, { waitMs: 150, pollMs: 20 });
    expect(result.isErr() && result.error._tag).toBe("RcsPhoneBusyError");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
