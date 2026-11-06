/** Structured log fields. Never put cookies, tokens, keys, message bodies or phone numbers here. */
export type GMLogFields = Record<string, string | number | boolean | null>;

export type GMLogger = {
  debug(msg: string, fields?: GMLogFields): void;
  info(msg: string, fields?: GMLogFields): void;
  warn(msg: string, fields?: GMLogFields): void;
  error(msg: string, fields?: GMLogFields): void;
};

const ignore = (): void => {};

export const GMLogger = {
  /** Discards everything. */
  noop: { debug: ignore, info: ignore, warn: ignore, error: ignore } satisfies GMLogger,
} as const;
