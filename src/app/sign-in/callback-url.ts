const DEFAULT_CALLBACK_URL = "/dashboard";
const MAX_LENGTH = 2048;
const PROBE_ORIGIN = "https://callback.invalid";

/**
 * Where to go after sign-in. Only same-origin relative paths are
 * accepted ("/oauth/authorize?...", "/dashboard"); anything that could leave
 * the site (absolute URLs, "//host", "/\host", control characters) falls back
 * to the dashboard.
 */
export const CallbackUrl = {
  DEFAULT: DEFAULT_CALLBACK_URL,
  parse: (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) {
      return DEFAULT_CALLBACK_URL;
    }
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
      return DEFAULT_CALLBACK_URL;
    }
    const unsafeChar = [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    });
    if (unsafeChar || !URL.canParse(value, PROBE_ORIGIN)) return DEFAULT_CALLBACK_URL;
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN ? value : DEFAULT_CALLBACK_URL;
  },
} as const;
