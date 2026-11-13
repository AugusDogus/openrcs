import { expect, test } from "bun:test";
import { timeAgo } from "./time";

const now = new Date("2026-11-13T12:00:00Z");
const before = (ms: number) => new Date(now.getTime() - ms);

test("timeAgo picks the largest whole unit", () => {
  expect(timeAgo(before(10_000), now)).toBe("just now");
  expect(timeAgo(before(3 * 60_000), now)).toBe("3 minutes ago");
  expect(timeAgo(before(2 * 3_600_000), now)).toBe("2 hours ago");
  expect(timeAgo(before(26 * 3_600_000), now)).toBe("yesterday");
  expect(timeAgo(before(15 * 86_400_000), now)).toBe("2 weeks ago");
});
