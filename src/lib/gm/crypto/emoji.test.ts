import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/crypto-emoji.json";
import { pairingEmojisV0, pairingEmojisV1 } from "./emoji";

describe("pairing emoji tables (libgm pair_google.go parity)", () => {
  test("V0 equals libgm pairingEmojisV0, duplicates included", () => {
    expect([...pairingEmojisV0]).toEqual(fixture.v0);
    expect(new Set(pairingEmojisV0).size).toBeLessThan(pairingEmojisV0.length);
  });

  test("V1 equals libgm pairingEmojisV1 as computed by its init()", () => {
    expect([...pairingEmojisV1]).toEqual(fixture.v1);
    expect(new Set(pairingEmojisV1).size).toBe(pairingEmojisV1.length);
  });

  test("tables are frozen", () => {
    expect(Object.isFrozen(pairingEmojisV0)).toBe(true);
    expect(Object.isFrozen(pairingEmojisV1)).toBe(true);
  });
});
