# Vault, OAuth and service-layer contract

Binding interfaces between the security core (`src/lib/vault`,
`src/lib/oauth`, `/api/mcp` auth) and the service layer (`src/lib/rcs`, MCP
tools, pairing and dashboard routes). Read docs/security.md for the design.
The database schema is fixed: `src/lib/db/app-schema.ts` and
`src/lib/db/vault-schema.ts` with migrations in `drizzle/` (0000-0004). Do not
change the schema or generate migrations without updating this file.

All fallible functions return `Result` / `Promise<Result>` from
`better-result` with `TaggedError` classes. `Database` is the Drizzle type
from `src/lib/db/client.ts`; functions take it as a parameter (tests pass a
temp file DB migrated with the real migrations).

## `src/lib/vault` (security core)

```ts
// dek.ts
export type Dek = { readonly id: string; readonly bytes: Uint8Array }; // id = dek_id (random, non-secret)
export const Dek = { generate(): Dek } as const;

// data-box.ts: AES-256-GCM with the DEK, versioned envelope "d1.<iv>.<ct>"
export type DataBoxAad = { userId: string; table: string; rowKey: string; column: string };
export const DataBox = {
  seal(dek: Dek, plaintext: string, aad: DataBoxAad): string;
  open(dek: Dek, envelope: string, aad: DataBoxAad): Result<string, DataBoxOpenError>;
  sealJson(dek: Dek, value: unknown, aad: DataBoxAad): string;
  openJson<T>(dek: Dek, envelope: string, aad: DataBoxAad, schema: z.ZodType<T>):
    Result<T, DataBoxOpenError | DataBoxSchemaError>;
} as const;

// device.ts: the browser key slot
export const DEVICE_COOKIE = "__Host-openrcs-device"; // "__openrcs-device" over http://localhost in dev
export const DeviceUnlock = {
  /** Unwrap the user's DEK from the device cookie in `cookieHeader`.
   *  Errors: VaultLockedError (no/invalid/revoked/stale slot: this browser
   *  cannot unlock; the user re-pairs here or uses the browser that paired). */
  unlock(db: Database, userId: string, cookieHeader: string | null):
    Promise<Result<Dek, VaultLockedError | VaultStorageError>>;
} as const;

// pairing-keys.ts: used by the pairing routes
export type PreparedPairingKey = {
  readonly userId: string;
  readonly dek: Dek;
  /** true when no valid device slot existed, so this pairing mints a new DEK. */
  readonly isNewKey: boolean;
  /** Set-Cookie header value to send at the START of the pairing response
   *  (headers cannot change once the SSE stream begins). null if the
   *  existing device cookie stays valid. */
  readonly setCookie: string | null;
};
export const PairingKeys = {
  prepare(db: Database, userId: string, cookieHeader: string | null):
    Promise<Result<PreparedPairingKey, VaultStorageError>>;
  /** After the phone confirms. If isNewKey: revoke every old slot and grant of
   *  the user and call `onKeyRotated` (the service layer deletes the user's old
   *  conversations/messages/sync_state there) BEFORE the caller writes the new
   *  gm_session. Then persist the device slot announced by setCookie. */
  commit(db: Database, prepared: PreparedPairingKey, hooks: { onKeyRotated: () => Promise<void> }):
    Promise<Result<void, VaultStorageError>>;
} as const;

export const Vault = {
  /** Unpair/delete: revoke and delete every slot and grant of the user. */
  revokeAll(db: Database, userId: string): Promise<Result<void, VaultStorageError>>;
  /** Clear-Site cookie header value removing the device cookie. */
  clearDeviceCookie(): string;
} as const;
```

## `src/lib/oauth` (security core)

Implements docs/security.md "OAuth 2.1 authorization server for MCP". The only
export the service layer uses:

```ts
export type McpScope = "messages:read" | "messages:send";
export type McpAuth = {
  readonly userId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
  readonly dek: Dek;
};
```

`/api/mcp/route.ts` (security core) authenticates the bearer token, then calls
`createRcsMcpServer({ auth })` (service layer) per request.

## `src/lib/mcp` (service layer)

```ts
// context.ts
export type RcsMcpContext = { readonly auth: McpAuth };
export type RcsToolRegistrar = (server: McpServer, ctx: RcsMcpContext) => void;
// server.ts
export const createRcsMcpServer: (ctx: RcsMcpContext) => McpServer;
```

Tools check `ctx.auth.scopes` themselves (read tools need `messages:read`,
`send_message` needs `messages:send`) and return an `isError` result naming
the missing scope and how to fix it (re-authorize the client with that scope).

## `src/lib/rcs` (service layer)

Everything that touches the phone or stored messages takes a `Dek`:
`withPhone(db, { userId, dek }, fn)`, `syncUser(db, { userId, dek }, opts)`,
`searchMessages(db, { userId, dek }, query)`, `sendText(db, { userId, dek }, req)`,
`deleteUserData(db, userId)` (no DEK needed: deletes rows).

DataBox AAD conventions (both sides must agree):
- `gm_session.auth_data_enc`: `{ userId, table: "gm_session", rowKey: userId, column: "auth_data" }`
- `conversation.content_enc`: `{ userId, table: "conversation", rowKey: conversationId, column: "content" }`
- `message.content_enc`: `{ userId, table: "message", rowKey: messageId, column: "content" }`
