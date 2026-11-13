// Google account cookies for Gaia pairing, read from the pairing browser's
// profile (src/lib/pairing-browser/chromium-cookies.ts).

export type GoogleCookies = Record<string, string>;

/** The cookies Google Messages needs to recognize a signed-in account. */
export const REQUIRED_GOOGLE_COOKIES = ["SID", "HSID", "SSID", "APISID", "SAPISID"] as const;
