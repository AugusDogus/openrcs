import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";

import { BugleRoute, IncomingRPCMessageSchema, LongPollingPayloadSchema } from "@/gen/gmproto/rpc_pb";

import { GMLogger } from "./logger";
import { LongPoll, type LongPollEvent, type LongPollFrame } from "./longpoll";
import { Pblite } from "./pblite";

const encoder = new TextEncoder();

const dataFrame = (responseID: string, signatureID: string): string =>
  Pblite.marshal(
    LongPollingPayloadSchema,
    create(LongPollingPayloadSchema, {
      data: create(IncomingRPCMessageSchema, { responseID, bugleRoute: BugleRoute.DataEvent, signatureID, messageData: Uint8Array.of(1, 2, 3) }),
    }),
  );

// Strings that contain every structural byte, escapes and multi-byte UTF-8.
const FRAMES = [
  Pblite.marshal(LongPollingPayloadSchema, create(LongPollingPayloadSchema, { ack: { count: 2 } })),
  dataFrame("r1", 'quote " and backslash \\ and ]][[,,'),
  Pblite.marshal(LongPollingPayloadSchema, create(LongPollingPayloadSchema, { heartbeat: {} })),
  dataFrame("r2-é😀", "emoji 😀🍋‍🟩 and ü and \\\" ]"),
  Pblite.marshal(LongPollingPayloadSchema, create(LongPollingPayloadSchema, { startRead: {} })),
];
const BODY = encoder.encode(`[[${FRAMES.join(",")}]]`);

const summarize = (frame: LongPollFrame): string => {
  switch (frame.kind) {
    case "data":
      return `data:${frame.message.responseID}:${frame.message.signatureID}`;
    case "ack":
      return `ack:${frame.count}`;
    default:
      return frame.kind;
  }
};

const EXPECTED = [
  "opened",
  "ack:2",
  'data:r1:quote " and backslash \\ and ]][[,,',
  "heartbeat",
  "data:r2-é😀:emoji 😀🍋‍🟩 and ü and \\\" ]",
  "startRead",
  "ended",
];

const run = (chunks: readonly Uint8Array[]): string[] => {
  const parser = LongPoll.createParser();
  const out: string[] = [];
  for (const chunk of chunks) {
    for (const event of parser.push(chunk).unwrap()) out.push(describeEvent(event));
  }
  return out;
};

const describeEvent = (event: LongPollEvent): string => (event.kind === "frame" ? summarize(event.frame) : event.kind);

const splitAt = (bytes: Uint8Array, points: readonly number[]): Uint8Array[] => {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const p of points) {
    out.push(bytes.slice(start, p));
    start = p;
  }
  out.push(bytes.slice(start));
  return out;
};

describe("LongPoll parser", () => {
  test("parses the whole body in one chunk", () => {
    expect(run([BODY])).toEqual(EXPECTED);
  });

  test("every two-chunk split point gives the same frames (including inside UTF-8 sequences and escapes)", () => {
    for (let i = 0; i <= BODY.length; i++) expect(run(splitAt(BODY, [i]))).toEqual(EXPECTED);
  });

  test("every three-chunk split of a smaller body gives the same frames", () => {
    const small = encoder.encode(`[[${FRAMES[1]},${FRAMES[3]}]]`);
    const expected = ["opened", EXPECTED[2], EXPECTED[4], "ended"];
    for (let i = 0; i <= small.length; i++) {
      for (let j = i; j <= small.length; j++) expect(run(splitAt(small, [i, j]))).toEqual(expected);
    }
    // ~60k parses: about 1.5 s idle, past bun's 5 s default on a loaded machine.
  }, 30_000);

  test("byte-by-byte feeding gives the same frames", () => {
    expect(run(Array.from(BODY, (b) => Uint8Array.of(b)))).toEqual(EXPECTED);
  });

  test("tolerates whitespace between frames and an empty stream", () => {
    expect(run([encoder.encode(`[[ ${FRAMES[0]} ,\n${FRAMES[2]}\r\n]]`)])).toEqual(["opened", "ack:2", "heartbeat", "ended"]);
    expect(run([encoder.encode("[[]]")])).toEqual(["opened", "ended"]);
  });

  test("an element that is not a LongPollingPayload is reported as invalid, and parsing continues", () => {
    // Field 2 (data) must be a message array, not a string.
    expect(run([encoder.encode(`[[[null,"not a message"],${FRAMES[2]}]]`)])).toEqual(["opened", "invalid", "heartbeat", "ended"]);
  });

  test("an all-null element is an unknown frame", () => {
    expect(run([encoder.encode("[[[null,null]]]")])).toEqual(["opened", "unknown", "ended"]);
  });

  test.each([
    ["does not start with [[", "[x"],
    ["has a stray comma", "[[,"],
    ["has frames without a comma", `[[${FRAMES[2]}${FRAMES[2]}`],
    ["has a bad end marker", "[[]x"],
  ])("rejects a stream that %s", (_, text) => {
    const result = LongPoll.createParser().push(encoder.encode(text));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("long poll stream is malformed");
  });

  test("reports data after the end marker without failing", () => {
    expect(run([encoder.encode("[[]] x")])).toEqual(["opened", "ended", "trailingData"]);
  });

  test("consume() reads a ReadableStream to its end and reports what it saw", async () => {
    const chunks = splitAt(BODY, [3, 50, 51, 200]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const frames: string[] = [];
    let opened = 0;
    const outcome = await LongPoll.consume(body, { onOpened: () => opened++, onFrame: (f) => frames.push(summarize(f)), logger: GMLogger.noop });
    expect(opened).toBe(1);
    expect(frames).toEqual(EXPECTED.slice(1, -1));
    expect(outcome).toEqual({ kind: "eof", opened: true, ended: true, frames: 5 });
  });

  test("consume() stops when its signal aborts", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("[["));
      },
    });
    const pending = LongPoll.consume(body, { onOpened: () => controller.abort(), onFrame: () => {}, logger: GMLogger.noop }, controller.signal);
    const outcome = await pending;
    expect(outcome.kind).toBe("readError");
  });
});
