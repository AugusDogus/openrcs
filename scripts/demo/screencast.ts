/**
 * Smooth page capture: Chromium's screencast (CDP) sends a frame on every
 * repaint, timed on arrival; ffmpeg turns those into constant-frame-rate
 * video. Sharper and smoother than Playwright's built-in VP8 recording.
 */
import { spawnSync } from "node:child_process";
import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

/** `t`: seconds, wall clock (`Date.now() / 1000`). */
export type Frame = { readonly data: Buffer; readonly t: number };

export type Screencast = {
  /** Stops capturing and returns the frames (`t` in seconds, wall clock). */
  readonly stop: () => Promise<Frame[]>;
};

export const startScreencast = async (
  page: Page,
  size: { width: number; height: number },
): Promise<Screencast> => {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    // Arrival time, on the same clock as the script's own timestamps (the
    // frame's own timestamp runs on a clock that can be seconds apart).
    frames.push({ data: Buffer.from(frame.data, "base64"), t: Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: size.width,
    maxHeight: size.height,
    everyNthFrame: 1,
  });
  return {
    stop: async () => {
      await cdp.send("Page.stopScreencast");
      await cdp.detach();
      return frames;
    },
  };
};

export const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
};

/** Output frame rate of every clip. */
export const FPS = 30;

/**
 * Writes the frames showing between `from` and `to` (seconds, wall clock)
 * to `dir` as a constant-rate image sequence (repeats are hard links) and
 * returns ffmpeg input arguments for it.
 */
export const writeFrameSequence = (frames: readonly Frame[], dir: string, from: number, to: number): string[] => {
  const count = Math.max(1, Math.round((to - from) * FPS));
  let source = 0;
  let written = -1;
  let lastPath = "";
  for (let index = 0; index < count; index += 1) {
    const at = from + index / FPS;
    while (source + 1 < frames.length && (frames[source + 1]?.t ?? Infinity) <= at) source += 1;
    const path = join(dir, `seq-${String(index).padStart(5, "0")}.jpg`);
    const frame = frames[source];
    if (frame === undefined) throw new Error("demo: the screencast captured no frames");
    if (source === written) linkSync(lastPath, path);
    else writeFileSync(path, frame.data);
    written = source;
    lastPath = path;
  }
  return ["-framerate", String(FPS), "-i", join(dir, "seq-%05d.jpg")];
};
