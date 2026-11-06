import { z } from "zod";

/**
 * Server-sent events of the pairing route (`POST /api/pair/gaia`). Shared by
 * the route (encode) and the pairing page (parse), so it must stay free of
 * server-only imports.
 */
export const PairingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("emoji"), emoji: z.string(), emojiImageUrl: z.string() }),
  z.object({ type: z.literal("paired") }),
  z.object({
    type: z.literal("sync"),
    conversationsDone: z.number().int().nonnegative(),
    conversationsTotal: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type PairingEvent = z.infer<typeof PairingEventSchema>;

/** One SSE frame. JSON.stringify never emits raw newlines, so one `data:` line suffices. */
const encode = (event: PairingEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** SSE comment frame that keeps idle connections open; parsers ignore it. */
const keepAlive = ": keep-alive\n\n";

export type PairingEventParser = {
  /** Feed decoded text; returns the complete events it contained. Malformed frames are dropped. */
  push(chunk: string): PairingEvent[];
};

const parseFrame = (frame: string): PairingEvent | null => {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    .join("\n");
  if (data === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = PairingEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

/** Incremental text/event-stream parser that tolerates frames split across chunks. */
const createParser = (): PairingEventParser => {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const events: PairingEvent[] = [];
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (match === null) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseFrame(frame);
        if (event !== null) events.push(event);
      }
      return events;
    },
  };
};

export const PairingEvent = { encode, keepAlive, createParser } as const;
