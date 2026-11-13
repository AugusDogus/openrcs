import { open } from "node:fs/promises";

// Sign-in detection for the pairing browser. Chromium writes its cookies to
// disk only every 30 s, but its NetLog (--log-net-log, default capture mode:
// no cookies or credentials) records each request within a second or two.
// Google redirects to the sign-in's `continue` URL, Messages for web, only
// once sign-in has finished, so the first request there means "signed in".

/** A request whose URL starts with Messages for web (the start URL only carries it percent-encoded). */
const SIGNED_IN_MARKER = '"url":"https://messages.google.com/web';

/** File name of the NetLog inside the browser profile. */
export const NET_LOG_FILE = "netlog.json";

/**
 * Returns a check that reads only what the log gained since the last call
 * (it grows to a few MB), keeping a short tail so a marker split across two
 * reads is still found.
 */
export const createSignInWatcher = () => {
  const progress = new Map<string, { offset: number; tail: string }>();
  return async (netLogPath: string): Promise<boolean> => {
    let handle;
    try {
      handle = await open(netLogPath, "r");
    } catch {
      return false;
    }
    try {
      const seen = progress.get(netLogPath) ?? { offset: 0, tail: "" };
      const { size } = await handle.stat();
      if (size < seen.offset) {
        seen.offset = 0;
        seen.tail = "";
      }
      const length = size - seen.offset;
      if (length <= 0) return false;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, seen.offset);
      const text = seen.tail + buffer.subarray(0, bytesRead).toString("latin1");
      progress.set(netLogPath, { offset: seen.offset + bytesRead, tail: text.slice(-SIGNED_IN_MARKER.length) });
      return text.includes(SIGNED_IN_MARKER);
    } finally {
      await handle.close();
    }
  };
};
