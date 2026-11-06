"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, buttonClass, Card } from "@/app/_components/ui";
import { PairingEvent } from "@/lib/rcs/pairing-event";

type FlowState =
  | { readonly stage: "idle" }
  | { readonly stage: "starting" }
  | { readonly stage: "emoji"; readonly emoji: string; readonly emojiImageUrl: string }
  | { readonly stage: "syncing"; readonly done: number; readonly total: number | null }
  | { readonly stage: "done"; readonly warning: string | null }
  | { readonly stage: "error"; readonly message: string };

const SECURITY_URL = "https://github.com/AugusDogus/openrcs/blob/main/docs/security.md";

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

/** POST the pasted cookies to the pairing route and drive `setState` from its event stream. */
const runPairing = async (
  cookies: string,
  signal: AbortSignal,
  setState: (state: FlowState) => void,
): Promise<void> => {
  setState({ stage: "starting" });
  let response: Response;
  try {
    response = await fetch("/api/pair/gaia", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies }),
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
        On a computer, open{" "}
        <a href="https://messages.google.com/web" target="_blank" rel="noreferrer" className="text-accent underline">
          messages.google.com/web
        </a>{" "}
        in Chrome, signed in to the Google account your phone&apos;s Google Messages uses.
      </li>
      <li>Open DevTools (F12, or Cmd+Option+I on a Mac), select the Network tab, then reload the page.</li>
      <li>
        Right-click any request to <code className="font-mono text-xs">messages.google.com</code> and choose
        Copy &gt; Copy as cURL.
      </li>
      <li>Paste it below and start pairing.</li>
    </ol>
  );
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

export function PairingFlow({ resetsData }: { resetsData: boolean }) {
  const [state, setState] = useState<FlowState>({ stage: "idle" });
  const [cookies, setCookies] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function start() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void runPairing(cookies, controller.signal, setState);
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ stage: "idle" });
  }

  return (
    <div className="flex flex-col gap-6">
      {resetsData ? (
        <Alert tone="warning">
          This browser does not hold the key to your existing pairing. Pairing here creates a new key: your stored
          messages will be deleted and connected agents disconnected. To keep them, pair from the browser you
          used before.
        </Alert>
      ) : null}

      <Card
        title="Pair with your Google account"
        description="Uses the Google account your phone's Google Messages is signed in to."
      >
        <div className="flex flex-col gap-5">
          {state.stage === "idle" || state.stage === "error" || state.stage === "starting" ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                start();
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
              <label htmlFor="cookies" className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Copied cURL command</span>
                <textarea
                  id="cookies"
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
              <button
                type="submit"
                disabled={state.stage === "starting" || cookies.trim() === ""}
                className={buttonClass("primary", "w-full sm:w-fit")}
              >
                {state.stage === "starting" ? "Contacting Google…" : "Start pairing"}
              </button>
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
              <p className="max-w-sm text-sm text-muted">
                Your phone shows a pairing prompt with several emoji. Pick the one above. Waiting for your phone…
              </p>
            </div>
          ) : null}

          {state.stage === "syncing" ? (
            <div className="flex flex-col gap-4">
              <Alert tone="success">Paired. Fetching your recent conversations…</Alert>
              <Progress done={state.done} total={state.total} />
            </div>
          ) : null}

          {state.stage === "done" ? (
            <div className="flex flex-col gap-4">
              <Alert tone="success">Your phone is paired.</Alert>
              {state.warning ? <Alert tone="warning">{state.warning}</Alert> : null}
              <Link href="/dashboard" className={buttonClass("primary", "w-full sm:w-fit")}>
                Back to the dashboard
              </Link>
            </div>
          ) : null}

          {state.stage === "emoji" ? (
            <button type="button" onClick={cancel} className={buttonClass("secondary", "w-full sm:w-fit self-center")}>
              Cancel
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
