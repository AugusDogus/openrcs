"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Actions, Alert, buttonClass, PageTitle, Spinner } from "@/app/_components/ui";
import { PairingEvent } from "@/lib/rcs/pairing-event";

type FlowState =
  | { readonly stage: "browserStarting" }
  | { readonly stage: "browser" }
  | { readonly stage: "starting" }
  | { readonly stage: "emoji"; readonly emoji: string; readonly emojiImageUrl: string }
  | { readonly stage: "syncing"; readonly done: number; readonly total: number | null }
  | { readonly stage: "done"; readonly warning: string | null }
  | { readonly stage: "error"; readonly message: string };

/** Where nginx serves the sign-in browser stream (docker/root/defaults/default.conf). */
const BROWSER_STREAM_PATH = "/pairing-browser/";
const BROWSER_POLL_MS = 1_500;

type BrowserReply =
  | { readonly ok: true; readonly status: "idle" | "signingIn" | "signedIn" }
  | { readonly ok: false; readonly message: string };

const readError = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Not JSON.
  }
  return `Pairing could not start (HTTP ${response.status}). Reload the page and try again.`;
};

const browserAction = async (action: "start" | "poll" | "stop", signal?: AbortSignal): Promise<BrowserReply> => {
  let response: Response;
  try {
    response = await fetch("/api/pair/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The browser's pages match this page's light or dark mode (the system's).
      body: JSON.stringify(
        action === "start"
          ? { action, colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" }
          : { action },
      ),
      signal,
      keepalive: action === "stop",
    });
  } catch {
    return { ok: false, message: "Could not reach openrcs. Check your connection and try again." };
  }
  if (!response.ok) return { ok: false, message: await readError(response) };
  const body: unknown = await response.json().catch(() => null);
  const status =
    typeof body === "object" && body !== null && "status" in body && typeof body.status === "string" ? body.status : null;
  return status === "idle" || status === "signingIn" || status === "signedIn"
    ? { ok: true, status }
    : { ok: false, message: "openrcs sent an unexpected answer. Reload the page and try again." };
};

/** Ask openrcs to pair with the cookies the sign-in browser captured, and drive `setState` from its event stream. */
const runPairing = async (
  signal: AbortSignal,
  setState: (state: FlowState) => void,
): Promise<void> => {
  setState({ stage: "starting" });
  let response: Response;
  try {
    response = await fetch("/api/pair/gaia", {
      method: "POST",
      signal,
    });
  } catch {
    if (!signal.aborted) {
      setState({ stage: "error", message: "Could not reach openrcs. Check your connection and try again." });
    }
    return;
  }
  if (!response.ok || response.body === null) {
    setState({ stage: "error", message: await readError(response) });
    return;
  }

  const parser = PairingEvent.createParser();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let paired = false;
  let finished = false;
  const handle = (event: PairingEvent) => {
    switch (event.type) {
      case "emoji":
        setState({ stage: "emoji", emoji: event.emoji, emojiImageUrl: event.emojiImageUrl });
        break;
      case "paired":
        paired = true;
        setState({ stage: "syncing", done: 0, total: null });
        break;
      case "sync":
        setState({ stage: "syncing", done: event.conversationsDone, total: event.conversationsTotal });
        break;
      case "done":
        finished = true;
        setState({ stage: "done", warning: null });
        break;
      case "error":
        finished = true;
        setState(paired ? { stage: "done", warning: event.message } : { stage: "error", message: event.message });
        break;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(value)) handle(event);
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!finished && !signal.aborted) {
    setState(
      paired
        ? { stage: "done", warning: "The connection closed during the first sync. Messages keep syncing when you use openrcs." }
        : { stage: "error", message: "The connection to openrcs closed before pairing finished. Start again." },
    );
  }
};

/** One fixed-size stage that every step shows in, so the page never jumps. */
function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-border bg-surface">
      {children}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 p-6 text-center">{children}</div>;
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 text-sm text-muted">
      <Spinner />
      {children}
    </p>
  );
}

function Emoji({ emoji, imageUrl }: { emoji: string; imageUrl: string }) {
  return imageUrl ? (
    // Google's own emoji artwork, so it looks exactly like the choice on the phone.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={imageUrl} alt={emoji} width={112} height={112} className="size-28" />
  ) : (
    <span className="text-8xl leading-none" aria-label={`Emoji ${emoji}`}>
      {emoji}
    </span>
  );
}

function Progress({ done, total }: { done: number; total: number | null }) {
  const percent = total === null || total === 0 ? null : Math.min(100, Math.round((done / total) * 100));
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-300 ease-out ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="text-sm text-muted tabular-nums">
        {total === null ? "Starting…" : `${done} of ${total} conversations`}
      </p>
    </div>
  );
}

/** The sign-in browser opens straight away. */
const INITIAL: FlowState = { stage: "browserStarting" };

const headingFor = (state: FlowState): { title: string; description?: string } => {
  switch (state.stage) {
    case "emoji":
      return { title: "Tap this emoji on your phone", description: "Google Messages on your phone shows a few. Pick this one." };
    case "syncing":
      return { title: "Syncing your messages" };
    case "done":
      return { title: "Your phone is paired" };
    default:
      return { title: "Pair your phone", description: "Sign in with the Google account your phone's Google Messages uses." };
  }
};

export function PairingFlow({ resetsData }: { resetsData: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<FlowState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  // The browser's sign-in is handed to pairing once, however many polls see it.
  const handedOffRef = useRef(false);

  // Closing the tab or reloading unmounts nothing, so close the sign-in browser on the way out too.
  useEffect(() => {
    const close = () => void browserAction("stop");
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, []);

  // Next keeps this page mounted but hidden after navigating away (Activity,
  // docs: guides/preserving-ui-state), and a Link back restores it. Reset on
  // hide so returning starts over and the sign-in browser closes.
  useLayoutEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      setState(INITIAL);
      void browserAction("stop");
    },
    [],
  );

  function freshSignal(): AbortSignal {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  }

  /** Start over with a fresh sign-in browser. */
  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    void browserAction("stop");
    setState(INITIAL);
  }

  function pairFromBrowser(signal: AbortSignal) {
    if (handedOffRef.current) return;
    handedOffRef.current = true;
    void runPairing(signal, setState);
  }

  // Open the sign-in browser as soon as the page shows.
  const browserStarting = state.stage === "browserStarting";
  useEffect(() => {
    if (!browserStarting) return;
    const signal = freshSignal();
    handedOffRef.current = false;
    void browserAction("start", signal).then((reply) => {
      if (signal.aborted) return;
      setState(reply.ok ? { stage: "browser" } : { stage: "error", message: reply.message });
    });
  }, [browserStarting]);

  // While it is open, ask openrcs whether Google has signed in yet.
  const browserOpen = state.stage === "browser";
  useEffect(() => {
    if (!browserOpen) return;
    const signal = abortRef.current?.signal;
    if (!signal) return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || signal.aborted || handedOffRef.current) return;
      polling = true;
      const reply = await browserAction("poll", signal);
      polling = false;
      if (signal.aborted || handedOffRef.current) return;
      if (!reply.ok) setState({ stage: "error", message: reply.message });
      else if (reply.status === "signedIn") pairFromBrowser(signal);
      else if (reply.status === "idle") {
        setState({ stage: "error", message: "The sign-in browser closed after 15 minutes without a sign-in." });
      }
    }, BROWSER_POLL_MS);
    return () => clearInterval(timer);
  }, [browserOpen]);

  // Paired cleanly: go straight to the dashboard, which now shows the phone.
  const pairedCleanly = state.stage === "done" && state.warning === null;
  useEffect(() => {
    if (!pairedCleanly) return;
    router.replace("/dashboard");
    router.refresh();
  }, [pairedCleanly, router]);

  const contacting = state.stage === "starting";
  const heading = headingFor(state);
  const inStage =
    state.stage === "browserStarting" ||
    state.stage === "browser" ||
    state.stage === "emoji" ||
    state.stage === "syncing" ||
    pairedCleanly ||
    contacting;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={heading.title}>{heading.description}</PageTitle>

      {resetsData && (state.stage === "browserStarting" || state.stage === "browser") ? (
        <Alert tone="warning">
          This browser does not hold the key to your existing pairing, so pairing here deletes your stored messages and
          disconnects your agents. To keep them, pair from the browser you used before.
        </Alert>
      ) : null}

      {inStage ? (
        <Stage>
          {state.stage === "browser" ? (
            <iframe
              src={BROWSER_STREAM_PATH}
              title="Google sign-in"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
              onLoad={(event) => event.currentTarget.focus()}
              className="absolute inset-0 size-full bg-black"
            />
          ) : state.stage === "emoji" ? (
            <Centered>
              <Emoji emoji={state.emoji} imageUrl={state.emojiImageUrl} />
              <Waiting>Waiting for your phone</Waiting>
            </Centered>
          ) : state.stage === "syncing" ? (
            <Centered>
              <Progress done={state.done} total={state.total} />
            </Centered>
          ) : (
            <Centered>
              <Waiting>{contacting ? "Contacting Google" : pairedCleanly ? "Opening openrcs" : "Starting a browser"}</Waiting>
            </Centered>
          )}
        </Stage>
      ) : null}

      {state.stage === "emoji" ? (
        <Actions>
          <button type="button" onClick={reset} className={buttonClass("ghost")}>
            Cancel
          </button>
        </Actions>
      ) : null}

      {state.stage === "error" ? (
        <>
          <Alert tone="danger">{state.message}</Alert>
          <Actions>
            <button type="button" onClick={reset} className={buttonClass("primary")}>
              Try again
            </button>
          </Actions>
        </>
      ) : null}

      {state.stage === "done" && state.warning !== null ? (
        <>
          <Alert tone="warning">{state.warning}</Alert>
          <Actions>
            <button
              type="button"
              onClick={() => {
                router.replace("/dashboard");
                router.refresh();
              }}
              className={buttonClass("primary")}
            >
              Continue
            </button>
          </Actions>
        </>
      ) : null}
    </div>
  );
}
