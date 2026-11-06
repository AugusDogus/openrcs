import { describe, expect, test } from "bun:test";
import { CallbackUrl } from "./callback-url";

describe("CallbackUrl.parse", () => {
  test("keeps same-origin relative paths", () => {
    for (const value of ["/dashboard", "/oauth/authorize?client_id=a&state=b%20c", "/dashboard/pair?method=qr"]) {
      expect(CallbackUrl.parse(value)).toBe(value);
    }
  });

  test("falls back to /dashboard for anything that could leave the site", () => {
    for (const value of [
      undefined,
      "",
      ["/dashboard"],
      "https://evil.example/",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "dashboard",
      "/\tevil",
      "/ok\n",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(CallbackUrl.parse(value)).toBe("/dashboard");
    }
  });
});
