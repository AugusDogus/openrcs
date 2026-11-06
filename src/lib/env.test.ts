import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Env } from "@/lib/env";

const validAuth = {
  BETTER_AUTH_URL: "https://openrcs.vercel.app/",
  BETTER_AUTH_SECRET: "x".repeat(32),
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: "secret",
};

/** Distinct variable names an error names (one variable can have several issues). */
const issueVariables = (
  result: ReturnType<typeof Env.parseAuth | typeof Env.parseVault | typeof Env.parseDatabase>,
) => (result.isErr() ? [...new Set(result.error.issues.map((issue) => issue.variable))] : []);

describe("Env.parseAuth", () => {
  test("accepts a complete section and strips the trailing slash", () => {
    expect(Env.parseAuth(validAuth).unwrap().BETTER_AUTH_URL).toBe("https://openrcs.vercel.app");
  });

  test("names every missing or invalid variable without echoing values", () => {
    const result = Env.parseAuth({
      BETTER_AUTH_URL: "ftp://example.com",
      BETTER_AUTH_SECRET: "short-secret-value",
    });
    expect(issueVariables(result).sort()).toEqual(
      ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"].sort(),
    );
    if (result.isErr()) {
      expect(result.error.section).toBe("auth");
      expect(result.error.message).toContain(".env.example");
      expect(result.error.message).not.toContain("short-secret-value");
    }
  });
});

describe("Env.parseVault", () => {
  test("accepts 32 random bytes in base64", () => {
    const pepper = randomBytes(32).toString("base64");
    expect(Env.parseVault({ KEY_PEPPER: pepper }).unwrap().KEY_PEPPER).toBe(pepper);
  });

  test("rejects missing, short, long and non-base64 peppers", () => {
    for (const KEY_PEPPER of [
      undefined,
      "",
      randomBytes(16).toString("base64"),
      randomBytes(33).toString("base64"),
      "not base64 at all!!",
    ]) {
      expect(issueVariables(Env.parseVault({ KEY_PEPPER }))).toEqual(["KEY_PEPPER"]);
    }
  });
});

describe("Env.parseDatabase", () => {
  test("accepts file: and libsql: URLs and treats an empty token as unset", () => {
    expect(Env.parseDatabase({ TURSO_DATABASE_URL: "file:./.data/dev.db", TURSO_AUTH_TOKEN: "" }).unwrap()).toEqual({
      TURSO_DATABASE_URL: "file:./.data/dev.db",
      TURSO_AUTH_TOKEN: undefined,
    });
    expect(
      Env.parseDatabase({ TURSO_DATABASE_URL: "libsql://db-org.turso.io", TURSO_AUTH_TOKEN: "t" }).unwrap()
        .TURSO_AUTH_TOKEN,
    ).toBe("t");
  });

  test("rejects other schemes", () => {
    expect(issueVariables(Env.parseDatabase({ TURSO_DATABASE_URL: "postgres://x" }))).toEqual([
      "TURSO_DATABASE_URL",
    ]);
  });
});
