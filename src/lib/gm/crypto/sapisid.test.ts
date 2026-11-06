import { expect, test } from "bun:test";
import fixture from "../__fixtures__/crypto-sapisid.json";
import { sapisidHash } from "./sapisid";

test.each(fixture.cases.map((c) => [c.origin, c.sapisid, c] as const))(
  "matches libgm SAPISIDHash for origin %s, sapisid %p",
  (origin, sapisid, c) => {
    expect(sapisidHash(origin, sapisid, c.unixSeconds)).toBe(c.hash);
  },
);

test("defaults the timestamp to now in whole seconds", () => {
  const before = Math.floor(Date.now() / 1000);
  const value = sapisidHash("https://messages.google.com", "abc");
  const ts = Number(/^SAPISIDHASH (\d+)_[0-9a-f]{40}$/.exec(value)?.[1]);
  expect(ts).toBeGreaterThanOrEqual(before);
  expect(ts).toBeLessThanOrEqual(before + 1);
});
