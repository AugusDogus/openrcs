import { describe, expect, test } from "bun:test";

import { GoogleCookies, type GoogleCookiesParseError } from "./google-cookies";

type RejectCase = [name: string, input: string, reason: GoogleCookiesParseError["reason"], missing: string[]];

const REQUIRED = { SID: "sid.v=1", HSID: "hsidV", SSID: "ssidV", APISID: "apisid/X", SAPISID: "sapisid/Y-z_" };
const EXPECTED = { ...REQUIRED, "__Secure-1PSID": "s1psid", OSID: "osid" };
const HEADER = "SID=sid.v=1; HSID=hsidV; SSID=ssidV; APISID=apisid/X; SAPISID=sapisid/Y-z_; __Secure-1PSID=s1psid; OSID=osid";

describe("GoogleCookies.parse", () => {
  test("a JSON object", () => {
    expect(GoogleCookies.parse(JSON.stringify(EXPECTED)).unwrap()).toEqual(EXPECTED);
  });

  test("a raw Cookie header, with or without the Cookie: prefix", () => {
    expect(GoogleCookies.parse(HEADER).unwrap()).toEqual(EXPECTED);
    expect(GoogleCookies.parse(`Cookie: ${HEADER}`).unwrap()).toEqual(EXPECTED);
    expect(GoogleCookies.parse(`cookie:${HEADER};`).unwrap()).toEqual(EXPECTED);
  });

  test("curl with bash single quotes and line continuations (DevTools Copy as cURL (bash))", () => {
    const curl = [
      "curl 'https://messages.google.com/web/config' \\",
      "  -H 'accept: */*' \\",
      "  -H 'accept-language: en-US,en;q=0.9' \\",
      `  -b '${HEADER}' \\`,
      "  -H 'x-client-data: CJa2yQE='",
    ].join("\n");
    expect(GoogleCookies.parse(curl).unwrap()).toEqual(EXPECTED);
  });

  test("curl with -H 'cookie: ...' split across multiple headers", () => {
    const curl = `curl 'https://messages.google.com/' -H 'Cookie: SID=sid.v=1; HSID=hsidV; SSID=ssidV' -H 'user-agent: x' --header 'cookie: APISID=apisid/X; SAPISID=sapisid/Y-z_' -H 'COOKIE: __Secure-1PSID=s1psid; OSID=osid'`;
    expect(GoogleCookies.parse(curl).unwrap()).toEqual(EXPECTED);
  });

  test("curl with $'...' ANSI-C quoting and escapes", () => {
    const curl = `curl $'https://messages.google.com/' -H $'cookie: SID=sid.v=1; HSID=hsidV; SSID=ssidV; APISID=apisid\\x2fX; SAPISID=sapisid/Y-z_; __Secure-1PSID=s1psid; OSID=osid' --data-raw $'{\\'a\\':1}'`;
    expect(GoogleCookies.parse(curl).unwrap()).toEqual(EXPECTED);
  });

  test("curl with double quotes, escapes and --cookie=", () => {
    const curl = `curl "https://messages.google.com/" -H "accept: \\"x\\"" --cookie="${HEADER}"`;
    expect(GoogleCookies.parse(curl).unwrap()).toEqual(EXPECTED);
  });

  test("curl from DevTools Copy as cURL (cmd) with ^ escaping and ^ line continuations", () => {
    // Chrome escapes \ and ", then carets every character outside its safe set.
    const cmdEscape = (s: string): string =>
      `^"${s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[^a-zA-Z0-9\s_\-:=+~'/.',?;()*`&]/g, "^$&")
        .replace(/%(?=[a-zA-Z0-9_])/g, "%^")
        .replace(/\r?\n/g, "^\n\n")}^"`;
    const curl = [
      `curl ${cmdEscape("https://messages.google.com/web/config")} ^`,
      `  -H ${cmdEscape("accept: */*")} ^`,
      `  -b ${cmdEscape(HEADER)} ^`,
      `  -H ${cmdEscape('x-test: "quoted" 100% done')}`,
    ].join("\r\n");
    expect(GoogleCookies.parse(curl).unwrap()).toEqual(EXPECTED);
  });

  test("quoted cookie values are unquoted and invalid pairs skipped, as Go net/http does", () => {
    // `semi="a` has a bare quote (skipped); the `b` after its ";" is a valueless cookie, which Go keeps.
    expect(GoogleCookies.parse(`${HEADER}; quoted="abc"; bad name=x; =novalue; semi="a;b`).unwrap()).toEqual({ ...EXPECTED, quoted: "abc", b: "" });
  });

  test.each<RejectCase>([
    ["empty input", "   ", "empty", ["SID", "HSID", "SSID", "APISID", "SAPISID"]],
    ["invalid JSON", "{nope", "invalidJson", []],
    ["a JSON array (read as a header with no cookies)", "[]", "noCookies", ["SID", "HSID", "SSID", "APISID", "SAPISID"]],
    ["curl without cookies", "curl 'https://x' -H 'accept: */*'", "noCookies", ["SID", "HSID", "SSID", "APISID", "SAPISID"]],
    ["curl with a cookie file", "curl 'https://x' -b cookies.txt", "invalidCurl", []],
    ["an unterminated quote", "curl 'https://x", "invalidCurl", []],
    ["missing SAPISID and HSID", "SID=a; SSID=b; APISID=c; OTHER=d", "missingRequired", ["HSID", "SAPISID"]],
  ])("rejects %s", (_, input, reason, missing) => {
    const result = GoogleCookies.parse(input);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe(reason);
      expect(result.error.missing).toEqual(missing);
      expect(result.error.message).toContain("Copy as cURL");
    }
  });

  test("error messages never contain cookie values", () => {
    const result = GoogleCookies.parse("SID=supersecretvalue; SSID=anothersecret");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).not.toContain("supersecret");
      expect(result.error.message).not.toContain("anothersecret");
      expect(result.error.message).toContain("HSID, APISID, SAPISID");
    }
  });
});
