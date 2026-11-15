/**
 * A visible mouse cursor for the demo recording (screencasts have none), and
 * natural mouse motion that can be logged on one page and replayed on another.
 */
import type { Page } from "playwright-core";

export type CursorKind = "arrow" | "text" | "pointer";

/** A rectangle (CSS px, viewport coordinates) where the cursor shows as `kind`. */
export type CursorZone = { x: number; y: number; width: number; height: number; kind: CursorKind };

declare global {
  interface Window {
    /** Set by the recording script for content the page cannot hit-test, such as the stage's video. */
    __demoCursorZones?: CursorZone[];
  }
}

/**
 * Init script for every page of the recording context (top frame only):
 * draws a macOS-like cursor that follows mouse events and shrinks a little
 * while pressed. Iframes ignore the mouse, so the top page sees every move.
 * Self-contained: Playwright serializes it.
 */
export function installCursor(): void {
  if (window.top !== window) return;
  const shapes: Record<string, { svg: string; hotspot: [number, number] }> = {
    arrow: {
      hotspot: [3, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="26" viewBox="0 0 20 26"><path d="M3 2v18.5l4.6-4.4 3.2 7.3 3.1-1.4-3.1-7.1h6.4z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    },
    text: {
      hotspot: [6, 11],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="22" viewBox="0 0 12 22"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2h2.2L6 3.2 7.3 2h2.2M6 3.2v15.6M2.5 20h2.2L6 18.8 7.3 20h2.2" stroke="#fff" stroke-width="3.4"/><path d="M2.5 2h2.2L6 3.2 7.3 2h2.2M6 3.2v15.6M2.5 20h2.2L6 18.8 7.3 20h2.2" stroke="#111" stroke-width="1.3"/></g></svg>',
    },
    pointer: {
      hotspot: [8, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="25" viewBox="0 0 22 25"><path d="M6.6 2.6c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v7.2h.5V7.9c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v2.4h.4V9c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v1.8h.3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v5.9c0 4.1-2.7 7.3-6.7 7.3h-2c-2.2 0-3.7-.9-5-2.7L1.8 15.1c-.6-.8-.4-1.9.4-2.4.8-.5 1.8-.3 2.4.4l2 2.5z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    },
  };

  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform-origin:0 0;transition:scale 90ms ease-out;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35));";
  let kind = "";
  const setKind = (next: string) => {
    if (next === kind) return;
    kind = next;
    const shape = shapes[next] ?? shapes.arrow;
    el.innerHTML = shape.svg;
    el.style.marginLeft = `${-shape.hotspot[0]}px`;
    el.style.marginTop = `${-shape.hotspot[1]}px`;
  };

  const kindAt = (x: number, y: number): string => {
    for (const zone of window.__demoCursorZones ?? []) {
      if (x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height) return zone.kind;
    }
    const target = document.elementFromPoint(x, y);
    if (target === null) return "arrow";
    const css = getComputedStyle(target).cursor;
    if (css === "pointer") return "pointer";
    if (css === "text" || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return "text";
    return "arrow";
  };

  const place = (x: number, y: number) => {
    // React owns <body>; re-attach to <html> if anything removed the cursor.
    if (!el.isConnected) document.documentElement.appendChild(el);
    setKind(kindAt(x, y));
    el.style.translate = `${x}px ${y}px`;
  };

  // The stage's iframe would swallow mouse events; the parent page draws the cursor over it.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("iframe { pointer-events: none !important; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  window.addEventListener("mousemove", (event) => place(event.clientX, event.clientY), true);
  window.addEventListener("mousedown", () => (el.style.scale = "0.86"), true);
  window.addEventListener("mouseup", () => (el.style.scale = "1"), true);
}

export type Point = { x: number; y: number };

/** One logged mouse action; `t` is seconds on the screencast clock (wall time). */
export type MouseStep =
  | { readonly type: "move"; readonly t: number; readonly x: number; readonly y: number }
  | { readonly type: "down" | "up"; readonly t: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Deterministic pseudo-random numbers, so re-recordings move the same way. */
export const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

/**
 * Drives `page.mouse` along eased, slightly curved paths at ~60 Hz, logging
 * every step (so a path driven inside the stage-sized
 * Google page can be replayed over the stage of the app page).
 */
export class Pointer {
  private position: Point;
  readonly log: MouseStep[] = [];

  constructor(
    private readonly page: Page,
    start: Point,
  ) {
    this.position = start;
  }

  get at(): Point {
    return this.position;
  }

  async jump(to: Point): Promise<void> {
    this.position = to;
    await this.page.mouse.move(to.x, to.y);
    this.log.push({ type: "move", t: Date.now() / 1000, ...to });
  }

  async move(to: Point, durationMs: number): Promise<void> {
    const from = this.position;
    // A gentle arc: the control point sits off the straight line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const control = { x: from.x + dx * 0.5 - dy * 0.12, y: from.y + dy * 0.5 + dx * 0.12 };
    const started = Date.now();
    for (;;) {
      const linear = Math.min(1, (Date.now() - started) / durationMs);
      const t = easeInOut(linear);
      const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x;
      const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y;
      await this.page.mouse.move(x, y);
      this.log.push({ type: "move", t: Date.now() / 1000, x, y });
      if (linear >= 1) break;
      await sleep(16);
    }
    this.position = to;
  }

  async down(): Promise<void> {
    await this.page.mouse.down();
    this.log.push({ type: "down", t: Date.now() / 1000 });
  }

  async up(): Promise<void> {
    await this.page.mouse.up();
    this.log.push({ type: "up", t: Date.now() / 1000 });
  }

  async click(holdMs = 90): Promise<void> {
    await this.down();
    await sleep(holdMs);
    await this.up();
  }
}

/**
 * Replays `events` (times relative to `t0`, seconds) on `page`, shifted by
 * `offset`, starting now. Use it over content that ignores the mouse (the
 * stage's video), so presses only show on the cursor.
 */
export const replay = async (
  page: Page,
  events: readonly MouseStep[],
  t0: number,
  offset: Point,
): Promise<Point> => {
  const started = Date.now() / 1000;
  let last: Point = { x: offset.x, y: offset.y };
  for (const event of events) {
    const wait = event.t - t0 - (Date.now() / 1000 - started);
    if (wait > 0) await sleep(wait * 1000);
    if (event.type === "move") {
      last = { x: event.x + offset.x, y: event.y + offset.y };
      await page.mouse.move(last.x, last.y);
    } else if (event.type === "down") {
      await page.mouse.down();
    } else {
      await page.mouse.up();
    }
  }
  return last;
};
