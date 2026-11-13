"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Actions, Alert, buttonClass, PageTitle, Spinner } from "@/app/_components/ui";
import { PairingEvent } from "@/lib/rcs/pairing-event";

type FlowState =
  | { readonly stage: "idle" }
  | { readonly stage: "browserStarting" }
  | { readonly stage: "browser" }
  | { readonly stage: "starting" }
  | { readonly stage: "emoji"; readonly emoji: string; readonly emojiImageUrl: string }
  | { readonly stage: "syncing"; readonly done: number; readonly total: number | null }
  | { readonly stage: "done"; readonly warning: string | null }
  | { readonly stage: "error"; readonly message: string };

/** How the user gives openrcs their Google cookies: the self-hosted sign-in browser, or (hosted) a pasted cURL command. */
type Method = "browser" | "curl";

/** Where nginx serves the sign-in browser stream (docker/root/defaults/default.conf). */
const BROWSER_STREAM_PATH = "/pairing-browser/";
const BROWSER_POLL_MS = 1_500;

/** Where the cookies for pairing come from: pasted text, or the self-hosted sign-in browser. */
type CookieSource = { readonly cookies: string } | { readonly source: "browser" };

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
      body: JSON.stringify({ action }),
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

/** POST the cookies (or the browser sign-in) to the pairing route and drive `setState` from its event stream. */
const runPairing = async (
  from: CookieSource,
  signal: AbortSignal,
  setState: (state: FlowState) => void,
): Promise<void> => {
  setState({ stage: "starting" });
  let response: Response;
  try {
    response = await fetch("/api/pair/gaia", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(from),
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

function GaiaInstructions() {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-6">
      <li>
        Open a new Incognito window in Chrome (Cmd+Shift+N, or Ctrl+Shift+N on Windows), go to{" "}
        <code className="font-mono text-xs">messages.google.com/web</code>, and sign in with the Google account
        your phone&apos;s Google Messages uses.
      </li>
      <li>Open DevTools (F12, or Cmd+Option+I on a Mac), select the Network tab, then reload the page.</li>
      <li>
        Right-click any request to <code className="font-mono text-xs">messages.google.com</code> and choose
        Copy &gt; Copy as cURL.
      </li>
      <li>
        Close the Incognito window without signing out. This gives openrcs its own Google session that no
        browser keeps changing; signing out would end it.
      </li>
      <li>Paste the copied command below.</li>
    </ol>
  );
}

/** One fixed-size stage that every step of the browser method shows in, so the page never jumps. */
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

/** The browser method opens its browser straight away; the cURL method waits for a paste. */
const initialState = (method: Method): FlowState =>
  method === "browser" ? { stage: "browserStarting" } : { stage: "idle" };

const headingFor = (state: FlowState, method: Method): { title: string; description?: string } => {
  switch (state.stage) {
    case "emoji":
      return { title: "Tap this emoji on your phone", description: "Google Messages on your phone shows a few. Pick this one." };
    case "syncing":
      return { title: "Syncing your messages" };
    case "done":
      return { title: "Your phone is paired" };
    default:
      return {
        title: "Pair your phone",
        description:
          method === "browser"
            ? "Sign in with the Google account your phone's Google Messages uses."
            : "Paste a cURL command from the Google account your phone's Google Messages uses.",
      };
  }
};

export function PairingFlow({ resetsData, browserSignIn }: { resetsData: boolean; browserSignIn: boolean }) {
  const router = useRouter();
  const method: Method = browserSignIn ? "browser" : "curl";
  const [state, setState] = useState<FlowState>(initialState(method));
  const [cookies, setCookies] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // The browser's sign-in is handed to pairing once, however many polls see it.
  const handedOffRef = useRef(false);

  // Closing the tab or reloading unmounts nothing, so close the sign-in browser on the way out too.
  useEffect(() => {
    if (method !== "browser") return;
    const close = () => void browserAction("stop");
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [method]);

  // Next keeps this page mounted but hidden after navigating away (Activity,
  // docs: guides/preserving-ui-state), and a Link back restores it. Reset on
  // hide so returning starts over, pasted cookies do not linger in the hidden
  // page, and the sign-in browser closes.
  useLayoutEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      setState(initialState(method));
      setCookies("");
      if (method === "browser") void browserAction("stop");
    },
    [method],
  );

  function freshSignal(): AbortSignal {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  }

  /** Start over with the same method (a fresh sign-in browser, or the empty form). */
  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    if (method === "browser") void browserAction("stop");
    setState(initialState(method));
  }

  function pairFromBrowser(signal: AbortSignal) {
    if (handedOffRef.current) return;
    handedOffRef.current = true;
    void runPairing({ source: "browser" }, signal, setState);
  }

  // Browser method: open the sign-in browser as soon as the page shows.
  const browserStarting = method === "browser" && state.stage === "browserStarting";
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
  const heading = headingFor(state, method);
  const inStage =
    state.stage === "browserStarting" ||
    state.stage === "browser" ||
    state.stage === "emoji" ||
    state.stage === "syncing" ||
    pairedCleanly ||
    (method === "browser" && contacting);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={heading.title}>{heading.description}</PageTitle>

      {resetsData && (state.stage === "idle" || state.stage === "browserStarting" || state.stage === "browser") ? (
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

      {method === "browser" && state.stage === "error" ? (
        <>
          <Alert tone="danger">{state.message}</Alert>
          <Actions>
            <button type="button" onClick={reset} className={buttonClass("primary")}>
              Try again
            </button>
          </Actions>
        </>
      ) : null}

      {method === "curl" && (state.stage === "idle" || state.stage === "error" || contacting) ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void runPairing({ cookies }, freshSignal(), setState);
          }}
        >
          <GaiaInstructions />
          <label htmlFor="curl-command" className="flex flex-col gap-2">
            <span className="text-sm font-medium">cURL command</span>
            {/* Never id="cookies": cookie-banner ad-block lists hide "#cookies.py-2". */}
            <textarea
              id="curl-command"
              value={cookies}
              onChange={(event) => setCookies(event.target.value)}
              rows={6}
              spellCheck={false}
              autoComplete="off"
              placeholder="curl 'https://messages.google.com/...' -H 'cookie: ...'"
              className="rounded-xl border border-border bg-surface px-3.5 py-3 font-mono text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          {state.stage === "error" ? <Alert tone="danger">{state.message}</Alert> : null}
          <Actions>
            <button type="submit" disabled={contacting || cookies.trim() === ""} className={buttonClass("primary")}>
              {contacting ? <Spinner className="size-3.5" /> : null}
              {contacting ? "Contacting Google" : "Pair"}
            </button>
          </Actions>
        </form>
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
