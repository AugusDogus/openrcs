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
/** Base name; each account's cookie is `${base}-${16 chars of base64url(SHA-256(userId))}`
 *  ("__openrcs-device" base over http://localhost in dev). */
export const DEVICE_COOKIE = "__Host-openrcs-device";
export const DeviceUnlock = {
  /** Unwrap the user's DEK from the device cookie in `cookieHeader`.
   *  Errors: VaultLockedError (no/invalid/revoked/stale slot: this browser
   *  cannot unlock; the user re-pairs here or uses the browser that paired). */
  unlock(db: Database, userId: string, cookieHeader: string | null):
    Promise<Result<Dek, VaultLockedError | VaultStorageError>>;
} as const;

// pairing-keys.ts: used by the pairing routes
/** Discriminated on isNewKey. isNewKey: true when no valid device slot
 *  existed, so this pairing mints a new DEK; setCookie is the Set-Cookie
 *  header value to send at the START of the pairing response (headers cannot
 *  change once the SSE stream begins), and pendingDeviceSlot is the new
 *  device slot row (no secret) that commit inserts. isNewKey: false keeps the
 *  existing device cookie (setCookie null). */
export type PreparedPairingKey =
  | { readonly userId: string; readonly dek: Dek; readonly isNewKey: false; readonly setCookie: null }
  | {
      readonly userId: string;
      readonly dek: Dek;
      readonly isNewKey: true;
      readonly setCookie: string;
      readonly pendingDeviceSlot: NewKeySlot;
    };
export const PairingKeys = {
  /** mode "pairing": use the device slot's DEK if valid, else mint a new DEK
   *  (always succeeds). mode "consent" (OAuth approval): same, except that if
   *  the user already has a gm_session and this browser cannot unlock it,
   *  return VaultLockedError instead of minting (minting would orphan the
   *  paired session). So a user can authorize an MCP client before pairing:
   *  the DEK and device slot are created at consent, and pairing later in the
   *  same browser reuses them. */
  prepare(db: Database, userId: string, cookieHeader: string | null, opts: { mode: "pairing" | "consent" }):
    Promise<Result<PreparedPairingKey, VaultLockedError | VaultStorageError>>;
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
  /** Set-Cookie header value removing this user's device cookie (other accounts' stay). */
  clearDeviceCookie(userId: string): string;
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

Dashboard component owned by the security core:
`src/app/dashboard/_components/connected-clients.tsx` exports
`ConnectedClients({ userId }: { userId: string })` (async server component:
lists the user's active grants with client name, scopes, created/last used,
and a revoke button posting to a security-core route). The service layer's
dashboard page renders it.

## `src/lib/mcp` (service layer)

```ts
// context.ts
export type RcsMcpContext = { readonly auth: McpAuth };
export type RcsToolRegistrar = (server: McpServer, ctx: RcsMcpContext) => void;
// server.ts
export const createRcsMcpServer: (ctx: RcsMcpContext) => McpServer;
```

Tools check `ctx.auth.scopes` themselves (read tools need `messages:read`,
`send_message` needs `messages:send`; `get_status` accepts either) and return
an `isError` result naming the missing scope and how to fix it (re-authorize
the client with that scope). Each scoped tool also declares the SDK's
`scopeChallenge`; since `/api/mcp` passes `authInfo`, the HTTP layer answers
403 `insufficient_scope` (docs/security.md) before the in-tool check runs.

## `src/lib/rcs` (service layer)

Everything that touches the phone or stored messages takes a `Dek`:
`withPhone(db, { userId, dek }, fn)`, `syncUser(db, { userId, dek }, opts)`,
`searchMessages(db, { userId, dek }, query)`, `sendText(db, { userId, dek }, req)`,
`deleteUserData(db, userId)` (no DEK needed: deletes rows).

DataBox AAD conventions (both sides must agree):
- `gm_session.auth_data_enc`: `{ userId, table: "gm_session", rowKey: userId, column: "auth_data" }`
- `conversation.content_enc`: `{ userId, table: "conversation", rowKey: conversationId, column: "content" }`
- `message.content_enc`: `{ userId, table: "message", rowKey: messageId, column: "content" }`
