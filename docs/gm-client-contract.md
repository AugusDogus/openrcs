# Google Messages client contract

The public API of `src/lib/gm/**` that the rest of the app (`src/lib/rcs/**`,
routes, MCP tools) codes against. The protocol layer implements exactly these
names and shapes; the service layer uses only these. Change this file first if
the contract must change.

All fallible operations return `Promise<Result<T, E>>` from `better-result`
with tagged error classes (`TaggedError` from `better-result`). Protobuf types
come from `src/gen/gmproto/*_pb.ts`. Nothing in `src/lib/gm` imports Next.js,
the database, or env; it takes everything it needs as arguments.

Logging: modules accept an optional `GMLogger`
(`{ debug(msg, fields?), info(msg, fields?), warn(msg, fields?), error(msg, fields?) }`
with `fields: Record<string, string | number | boolean | null>`). Never pass
cookies, tokens, keys, message bodies, or phone numbers to it.

## `src/lib/gm/auth-data.ts`

```ts
export type AuthData = {
  requestCrypto: AesCtrHelper;            // from crypto/aes-ctr
  refreshKey: Jwk;                        // from crypto/jwk
  browser: Device | null;                 // gmproto authentication Device
  mobile: Device | null;
  tachyonAuthToken: Uint8Array | null;
  tachyonExpiry: Date | null;
  tachyonTtlMicros: bigint;
  sessionId: string;                      // uuid, nil uuid by default (as in Go)
  destRegId: string | null;               // set => Google-account (Gaia) pairing
  pairingId: string | null;
  cookies: Record<string, string> | null; // Gaia only
};
export const AuthData = {
  createForPairing(): AuthData;           // fresh request crypto + refresh key
  isGoogleAccount(a: AuthData): boolean;  // destRegId !== null
  isLoggedIn(a: AuthData): boolean;       // browser set and (non-Gaia or cookies set)
  serialize(a: AuthData): string;         // JSON text; the caller seals it with secret-box
  parse(json: string): Result<AuthData, AuthDataParseError>;
} as const;
```

## `src/lib/gm/google-cookies.ts`

```ts
export type GoogleCookies = Record<string, string>;
export const GoogleCookies = {
  /** Accepts a JSON object, a `curl ...` command (Copy as cURL from DevTools,
   *  bash or cmd quoting, -H 'cookie: ...' or -b '...'), or a raw Cookie header
   *  (with or without a leading "Cookie:"). Requires SID, HSID, SSID, APISID,
   *  SAPISID. Error messages name missing cookie names, never values. */
  parse(input: string): Result<GoogleCookies, GoogleCookiesParseError>;
} as const;
```

## `src/lib/gm/client.ts`

```ts
export type GMEvent =
  | { type: "message"; message: Message; isOld: boolean }        // conversations Message
  | { type: "conversation"; conversation: Conversation }
  | { type: "typing"; data: TypingData }
  | { type: "userAlert"; alert: UserAlertEvent }
  | { type: "authDataChanged" }      // token refreshed or cookies rotated: persist AuthData
  | { type: "gaiaLoggedOut" }        // session is dead: needs re-pair
  | { type: "accountChange"; account: string; isFake: boolean }
  | { type: "listenFatal"; error: GMHttpError }          // 401/403 on long poll: needs re-pair
  | { type: "listenTemporary"; message: string };

export type GMClientOptions = {
  authData: AuthData;                  // the client mutates this object in place
  fetch?: typeof fetch;                // injectable for tests
  requestTimeoutMs?: number;           // per RPC, default 30_000
  onEvent?: (event: GMEvent) => void;
  logger?: GMLogger;
};

export type GMClient = {
  readonly authData: AuthData;
  /** Refresh the tachyon token if it expires within 1h, open the long poll,
   *  ack startup backlog, set the active session (GET_UPDATES). Resolves once
   *  RPCs can be sent. */
  connect(opts?: { signal?: AbortSignal }): Promise<Result<void, GMConnectError>>;
  /** Flush pending acks, close the long poll, fail pending requests. Idempotent. */
  close(): Promise<void>;
  /** Resolve after `quietMs` with no incoming data events (or `maxMs`). Used to
   *  drain queued updates during sync. */
  waitForQuiet(opts: { quietMs: number; maxMs: number }): Promise<void>;

  listConversations(req: { count: number; folder: ListConversationsRequest_Folder; cursor?: Cursor }): Promise<Result<ListConversationsResponse, GMRpcError>>;
  fetchMessages(req: { conversationId: string; count: number; cursor?: Cursor }): Promise<Result<ListMessagesResponse, GMRpcError>>;
  getConversation(conversationId: string): Promise<Result<Conversation, GMRpcError>>;
  getOrCreateConversation(req: GetOrCreateConversationRequest): Promise<Result<GetOrCreateConversationResponse, GMRpcError>>;
  sendMessage(req: SendMessageRequest): Promise<Result<SendMessageResponse, GMRpcError>>;
  sendReaction(req: SendReactionRequest): Promise<Result<SendReactionResponse, GMRpcError>>;
  markRead(conversationId: string, messageId: string): Promise<Result<void, GMRpcError>>;
  listContacts(): Promise<Result<ListContactsResponse, GMRpcError>>;
  listTopContacts(): Promise<Result<ListTopContactsResponse, GMRpcError>>;
  // libgm DownloadMedia: decrypted attachment bytes (src/lib/gm/media.ts). HTTP only, no phone RPC.
  downloadMedia(req: { mediaId: string; key: Uint8Array; signal?: AbortSignal }): Promise<Result<ReadableStream<Uint8Array>, GMMediaError>>;
  /** Best-effort unpair (Gaia: UNPAIR_GAIA_PAIRING; QR: RevokeRelayPairing). */
  unpair(): Promise<Result<void, GMRpcError | GMHttpError>>;
};
export const GMClient = { create(opts: GMClientOptions): GMClient } as const;
```

`GMRpcError` is a union of tagged errors including at least:
`GMPhoneNotRespondingError` (no answer within the timeout; a send may still be
delivered), `GMConnectionClosedError`, `GMNoResponsePayloadError`,
`GMHttpError` (`status`, `action`), `GMRequestError` (Google error message,
no secrets), `GMDecodeError`, `GMNotConnectedError`.
`GMConnectError` includes `GMHttpError`, `GMAuthExpiredError` (401/403 or
token refresh rejected: the user must re-pair), `GMNotLoggedInError`, and
network errors.

## `src/lib/gm/pair-gaia.ts`

```ts
export type GaiaPairingAttempt = { /* opaque */ };
export const GaiaPairing = {
  /** SignInGaia, pick the phone, open the long poll, send CLIENT_INIT.
   *  Resolves with the emoji the user must tap on their phone. */
  start(opts: { cookies: GoogleCookies; fetch?: typeof fetch; logger?: GMLogger; signal?: AbortSignal }):
    Promise<Result<{ emoji: string; emojiImageUrl: string; attempt: GaiaPairingAttempt }, GaiaPairingError>>;
  /** Send CLIENT_FINISHED and wait for the phone (up to `timeoutMs`, default
   *  5 min, or until `signal` aborts, which sends CANCEL_GAIA_PAIRING). On
   *  success returns logged-in AuthData ready to persist. Closes its connection. */
  finish(attempt: GaiaPairingAttempt, opts?: { signal?: AbortSignal; timeoutMs?: number }):
    Promise<Result<{ authData: AuthData; phoneId: string }, GaiaPairingError>>;
  cancel(attempt: GaiaPairingAttempt): Promise<void>;
} as const;
```

`GaiaPairingError` includes `GaiaNoDevicesError`, `GaiaIncorrectEmojiError`,
`GaiaCancelledError` (incl. "not me"), `GaiaTimeoutError`,
`GaiaInitTimeoutError` (`multipleDevices: boolean`), `GMAuthExpiredError`
(cookies rejected: user must copy fresh cookies), `GMHttpError`, network errors.

## `src/lib/gm/pair-qr.ts`

```ts
export type QrPairingAttempt = { /* opaque */ };
export const QrPairing = {
  start(opts: { fetch?: typeof fetch; logger?: GMLogger; signal?: AbortSignal }):
    Promise<Result<{ qrUrl: string; attempt: QrPairingAttempt }, QrPairingError>>;
  /** RefreshPhoneRelay: a new QR URL for the same attempt (call every ~30 s). */
  refresh(attempt: QrPairingAttempt): Promise<Result<string, QrPairingError>>;
  /** Wait for the phone to scan (PairEvent Paired). Closes its connection.
   *  Waits ~2 s after success before resolving, as libgm does. */
  waitForPair(attempt: QrPairingAttempt, opts?: { signal?: AbortSignal; timeoutMs?: number }):
    Promise<Result<{ authData: AuthData; phoneId: string }, QrPairingError>>;
  cancel(attempt: QrPairingAttempt): Promise<void>;
} as const;
```

## `src/lib/gm/message.ts`

Port of openmessage `internal/client/client.go` extraction helpers and
`internal/app/gm.go` payload builders.

```ts
export type PlainMedia = {
  mediaId: string; mimeType: string; name: string; size: number;
  key: string | null;            // base64 MediaContent.decryptionKey of `mediaId` (secret); null when absent
};
export type PlainReaction = { emoji: string; count: number; participantIds: string[] };
export type PlainMessage = {
  messageId: string; conversationId: string; timestampMs: number;
  fromMe: boolean; senderName: string | null; senderNumber: string | null;
  body: string;                  // text content, "" when media-only
  status: string;                // MessageStatusType name, e.g. "OUTGOING_DELIVERED"
  media: PlainMedia | null; replyToId: string | null; reactions: PlainReaction[];
  tmpId: string | null;
};
export type PlainParticipant = { participantId: string; name: string | null; number: string | null; isMe: boolean };
export type PlainConversation = {
  conversationId: string; name: string; isGroup: boolean;
  participants: PlainParticipant[];
  lastMessageTimestampMs: number; lastMessagePreview: string | null;
  unread: boolean; readOnly: boolean; status: string;
};
export const GMMessage = { toPlain(m: Message): PlainMessage } as const;
export const GMConversation = {
  toPlain(c: Conversation): PlainConversation;
  /** Our participant id + SIM payload, falling back to the conversation SIM card. */
  self(c: Conversation): { participantId: string; sim: SIMPayload | null };
} as const;
export const SendPayload = {
  text(opts: { conversationId: string; text: string; participantId: string; sim: SIMPayload | null; replyToId?: string; tmpId?: string }): SendMessageRequest;
  contactNumbers(phones: string[]): ContactNumber[];   // MysteriousInt 7, Number and Number2
  newTmpId(): string;                                  // "tmp_" + 12 digits
} as const;
```

`timestampMs` converts the protobuf microsecond timestamps to milliseconds.
