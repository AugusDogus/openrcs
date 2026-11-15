/**
 * Records Google's real sign-in page (the page openrcs's sign-in browser
 * opens) at the size of the pairing stage: the cursor clicks the email
 * field, a demo address is typed, and the cursor presses Next. The mouse is
 * never released over Next, so nothing is submitted to Google; the footage
 * ends while the button is held down.
 */
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { PAIRING_BROWSER_START_URL } from "@/lib/pairing-browser/pairing-browser";
import { Pointer, seededRandom, type CursorZone, type MouseStep, type Point } from "./cursor";
import { run, startScreencast, writeFrameSequence } from "./screencast";

export type Footage = {
  /** VP9 WebM of the page, stage-sized. */
  readonly clip: string;
  /** Wall-clock second of the clip's first frame; `events` use the same clock. */
  readonly t0: number;
  readonly events: readonly MouseStep[];
  /** Where the cursor changes shape, relative to the page (the stage). */
  readonly zones: readonly CursorZone[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const recordGoogleFootage = async (
  browser: Browser,
  opts: {
    readonly size: { width: number; height: number };
    readonly scale: number;
    readonly userAgent: string;
    readonly email: string;
    /** Where the cursor starts, relative to the stage (it may be outside it). */
    readonly start: Point;
    readonly workDir: string;
  },
): Promise<Footage> => {
  const context = await browser.newContext({
    viewport: opts.size,
    deviceScaleFactor: opts.scale,
    colorScheme: "dark",
    locale: "en-US",
    userAgent: opts.userAgent,
  });
  try {
    const page = await context.newPage();
    await page.goto(PAIRING_BROWSER_START_URL, { waitUntil: "networkidle" });
    const email = page.locator("#identifierId");
    const next = page.getByRole("button", { name: "Next" });
    await email.waitFor();
    const emailBox = await email.boundingBox();
    const nextBox = await next.boundingBox();
    if (emailBox === null || nextBox === null) throw new Error("Google's sign-in page has no visible email field or Next button");
    await sleep(800);

    const pointer = new Pointer(page, opts.start);
    await pointer.jump(opts.start);
    const capture = await startScreencast(page, {
      width: Math.round(opts.size.width * opts.scale),
      height: Math.round(opts.size.height * opts.scale),
    });
    await sleep(150);
    const t0 = Date.now() / 1000;

    const random = seededRandom(7);
    await sleep(450);
    await pointer.move({ x: emailBox.x + emailBox.width * 0.62, y: emailBox.y + emailBox.height * 0.55 }, 800);
    await sleep(120);
    await pointer.click();
    // Out of the way of the text about to be typed.
    await pointer.move({ x: pointer.at.x + 26, y: emailBox.y + emailBox.height + 22 }, 320);
    await sleep(120);
    for (const char of opts.email) {
      await page.keyboard.type(char);
      const pause = char === "@" || char === "." ? 150 : 55;
      await sleep(pause + random() * 70);
    }
    await sleep(380);
    await pointer.move({ x: nextBox.x + nextBox.width * 0.48, y: nextBox.y + nextBox.height * 0.55 }, 650);
    await sleep(140);
    await pointer.down();
    await sleep(300);
    const t1 = Date.now() / 1000;
    const frames = await capture.stop();

    // The button is still held, so Google has received nothing; make sure the page agrees.
    if (!page.url().includes("/signin/identifier")) throw new Error(`Google's page navigated during the footage (${page.url()})`);

    const input = writeFrameSequence(frames, opts.workDir, t0, t1);
    const clip = join(opts.workDir, "footage.webm");
    run("ffmpeg", [
      ...["-v", "error", "-y", ...input],
      ...["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p"],
      ...["-c:v", "libvpx-vp9", "-crf", "16", "-b:v", "0", "-deadline", "good", "-an", clip],
    ]);
    return {
      clip,
      t0,
      events: pointer.log.filter((event) => event.t >= t0),
      zones: [
        { ...emailBox, kind: "text" },
        { ...nextBox, kind: "pointer" },
      ],
    };
  } finally {
    await context.close();
  }
};
