import { describe, expect, test } from "bun:test";
import { describeAuthLogArg } from "./auth";

describe("Better Auth log arguments", () => {
  test("keep error names and causes but never a failed query's params", () => {
    const token = "SESSIONTOKENabcdefghijklmnopqrstu";
    const cause = new Error("During prerendering, fetch() rejects when the prerender is complete.");
    const failed = new Error(`Failed query: select "id" from "session" where "session"."token" = ?\nparams: ${token}`, {
      cause,
    });
    failed.name = "DrizzleQueryError";

    const logged = describeAuthLogArg(failed);

    expect(logged).not.toContain(token);
    expect(logged).toContain('DrizzleQueryError: Failed query: select "id" from "session" where "session"."token" = ?');
    expect(logged).toContain("caused by Error: During prerendering");
  });

  test("print only the type of values that are not errors", () => {
    expect(describeAuthLogArg({ token: "secret" })).toBe("<object>");
    expect(describeAuthLogArg("https://openrcs.test/callback?code=secret")).toBe("<string>");
  });
});
