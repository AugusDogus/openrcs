import { describe, expect, test } from "bun:test";
import { PairingEvent } from "./pairing-event";

const events: PairingEvent[] = [
  { type: "emoji", emoji: "🦊", emojiImageUrl: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f98a/512.png" },
  { type: "paired" },
  { type: "sync", conversationsDone: 3, conversationsTotal: 10 },
  { type: "error", message: "Line one.\nLine two with \"quotes\"." },
  { type: "done" },
];

describe("PairingEvent", () => {
  test("encodes one data frame per event", () => {
    expect(PairingEvent.encode({ type: "paired" })).toBe('data: {"type":"paired"}\n\n');
    for (const event of events) {
      const frame = PairingEvent.encode(event);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(frame.slice(0, -2)).not.toContain("\n");
    }
  });

  test("round-trips through the parser, even when frames are split across chunks", () => {
    const stream = PairingEvent.keepAlive + events.map(PairingEvent.encode).join("") + PairingEvent.keepAlive;
    const parser = PairingEvent.createParser();
    const parsed: PairingEvent[] = [];
    for (let i = 0; i < stream.length; i += 7) parsed.push(...parser.push(stream.slice(i, i + 7)));
    expect(parsed).toEqual(events);
  });

  test("drops malformed and unknown frames", () => {
    const parser = PairingEvent.createParser();
    const parsed = parser.push(
      'data: not json\n\ndata: {"type":"unknown"}\n\ndata: {"type":"sync","conversationsDone":-1,"conversationsTotal":1}\n\nevent: x\n\ndata: {"type":"done"}\r\n\r\n',
    );
    expect(parsed).toEqual([{ type: "done" }]);
  });
});
