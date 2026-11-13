import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSignInWatcher } from "./net-log";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openrcs-netlog-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const event = (url: string) => `{"params":{"url":"${url}"},"type":2},\n`;

test("a missing log is not signed in", async () => {
  expect(await createSignInWatcher()(join(dir, "netlog.json"))).toBe(false);
});

test("only a request to Messages for web counts, not the encoded continue URL", async () => {
  const path = join(dir, "netlog.json");
  const seen = createSignInWatcher();
  await writeFile(
    path,
    `{"constants":{},"events":[\n${event("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmessages.google.com%2Fweb%2F")}`,
  );
  expect(await seen(path)).toBe(false);
  await appendFile(path, event("https://messages.google.com/web/"));
  expect(await seen(path)).toBe(true);
});

test("finds the marker when it is split across two reads", async () => {
  const path = join(dir, "netlog.json");
  const seen = createSignInWatcher();
  const line = event("https://messages.google.com/web/conversations");
  const cut = line.indexOf("messages") + 4;
  await writeFile(path, line.slice(0, cut));
  expect(await seen(path)).toBe(false);
  await appendFile(path, line.slice(cut));
  expect(await seen(path)).toBe(true);
});
