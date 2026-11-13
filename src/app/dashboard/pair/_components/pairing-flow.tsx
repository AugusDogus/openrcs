"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, buttonClass, Card } from "@/app/_components/ui";
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

const SECURITY_URL = "https://github.com/AugusDogus/openrcs/blob/main/docs/security.md";

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
      <li>Paste the copied command below and start pairing.</li>
    </ol>
  );
}

function Spinner() {
  return <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent" />;
}

/** The sign-in browser's frame, or a placeholder of the same size while it starts or after it closed. */
function BrowserFrame({ live, placeholder }: { live: boolean; placeholder: string }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-border bg-surface-muted">
      {live ? (
        <iframe
          src={BROWSER_STREAM_PATH}
          title="Google sign-in"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          onLoad={(event) => event.currentTarget.focus()}
          className="absolute inset-0 size-full bg-black"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center gap-2.5 text-sm text-muted">
          <Spinner />
          {placeholder}
        </div>
      )}
    </div>
  );
}

/** Right-aligned action row, main action last (stacked on top on phones). */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}

function Progress({ done, total }: { done: number; total: number | null }) {
  const percent = total === null || total === 0 ? null : Math.min(100, Math.round((done / total) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={`h-full rounded-full bg-accent transition-[width] ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="text-sm text-muted">
        {total === null ? "Starting the first sync…" : `Synced ${done} of ${total} conversations…`}
      </p>
    </div>
  );
}

/** The browser method opens its browser straight away; the cURL method waits for a paste. */
const initialState = (method: Method): FlowState =>
  method === "browser" ? { stage: "browserStarting" } : { stage: "idle" };

export function PairingFlow({ resetsData, browserSignIn }: { resetsData: boolean; browserSignIn: boolean }) {
  const method: Method = browserSignIn ? "browser" : "curl";
  const [state, setState] = useState<FlowState>(initialState(method));
  const [cookies, setCookies] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // The browser's sign-in is handed to pairing once, however many polls see it.
  const handedOffRef = useRef(false);

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

  const signingIn = method === "browser" && (state.stage === "browserStarting" || state.stage === "browser");
  const contacting = state.stage === "starting";
  const showForm = method === "curl" && (state.stage === "idle" || state.stage === "error" || contacting);

  const heading =
    state.stage === "emoji"
      ? { title: "Confirm on your phone", description: "Step 2 of 2" }
      : state.stage === "syncing"
        ? { title: "Syncing your conversations", description: "Paired" }
        : state.stage === "done"
          ? { title: "Your phone is paired", description: undefined }
          : method === "browser"
            ? {
                title: "Sign in to Google",
                description: "Step 1 of 2 · Use the Google account your phone's Google Messages is signed in to.",
              }
            : {
                title: "Paste your Google cookies",
                description: "Step 1 of 2 · From the Google account your phone's Google Messages is signed in to.",
              };

  return (
    <div className="flex flex-col gap-6">
      {resetsData ? (
        <Alert tone="warning">
          This browser does not hold the key to your existing pairing. Pairing here creates a new key: your stored
          messages will be deleted and connected agents disconnected. To keep them, pair from the browser you
          used before.
        </Alert>
      ) : null}

      <Card title={heading.title} description={heading.description}>
        <div className="flex flex-col gap-5">
          {method === "browser" && (signingIn || contacting) ? (
            <>
              <BrowserFrame
                live={state.stage === "browser"}
                placeholder={contacting ? "Signed in. Contacting Google…" : "Starting a private browser…"}
              />
              <p className="text-xs leading-5 text-muted">
                Runs on your openrcs server. openrcs keeps only the Google cookies it needs to pair and deletes the
                rest.
              </p>
            </>
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

          {showForm ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void runPairing({ cookies }, freshSignal(), setState);
              }}
            >
              <GaiaInstructions />
              <p className="rounded-lg bg-surface-muted px-3.5 py-3 text-xs leading-5 text-muted">
                Your cookies are encrypted with a key that only this browser and the agents you authorize hold
                (see{" "}
                <a href={SECURITY_URL} target="_blank" rel="noreferrer" className="underline">
                  the security design
                </a>
                ). Google cookies grant broad access to your Google account.
              </p>
              <label htmlFor="curl-command" className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Copied cURL command</span>
                {/* Never id="cookies": cookie-banner ad-block lists hide "#cookies.py-2". */}
                <textarea
                  id="curl-command"
                  value={cookies}
                  onChange={(event) => setCookies(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="curl 'https://messages.google.com/...' -H 'cookie: ...'"
                  className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              {state.stage === "error" ? <Alert tone="danger">{state.message}</Alert> : null}
              <Actions>
                <button
                  type="submit"
                  disabled={contacting || cookies.trim() === ""}
                  className={buttonClass("primary")}
                >
                  {contacting ? <Spinner /> : null}
                  {contacting ? "Contacting Google…" : "Start pairing"}
                </button>
              </Actions>
            </form>
          ) : null}

          {state.stage === "emoji" ? (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              {state.emojiImageUrl ? (
                // Google's own emoji artwork, so it looks exactly like the choice on the phone.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={state.emojiImageUrl} alt={state.emoji} width={128} height={128} className="size-32" />
              ) : (
                <span className="text-8xl leading-none" aria-label={`Emoji ${state.emoji}`}>
                  {state.emoji}
                </span>
              )}
              <p className="text-base font-medium">Tap this emoji in Google Messages on your phone</p>
              <p className="flex max-w-sm items-center gap-2 text-sm text-muted">
                <Spinner />
                Waiting for your phone…
              </p>
              <button type="button" onClick={reset} className={buttonClass("ghost")}>
                Cancel
              </button>
            </div>
          ) : null}

          {state.stage === "syncing" ? <Progress done={state.done} total={state.total} /> : null}

          {state.stage === "done" ? (
            <>
              {state.warning ? <Alert tone="warning">{state.warning}</Alert> : null}
              <Actions>
                <Link href="/dashboard" className={buttonClass("primary")}>
                  Back to the dashboard
                </Link>
              </Actions>
            </>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
