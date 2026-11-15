# Vault, OAuth and service-layer contract

Binding interfaces between the security core (`src/lib/vault`,
`src/lib/oauth`, `/api/mcp` auth) and the service layer (`src/lib/rcs`, MCP
tools, pairing and dashboard routes). Read docs/security.md for the design.
The database schema is fixed: `src/lib/db/app-schema.ts` and
`src/lib/db/vault-schema.ts` with migrations in `drizzle/` (0000-0006). Do not
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

// server-key.ts: the server's copy of each user's DEK (user_key)
export const ServerKey = {
  /** The user's DEK, or null when the user has no key (never paired, or unpaired).
   *  ServerKeyInvalidError: the row does not open with this KEY_PEPPER. */
  unlock(db: Database, userId: string):
    Promise<Result<Dek | null, ServerKeyInvalidError | VaultStorageError>>;
  /** Mints a new DEK and stores its server copy, replacing any older key. */
  create(db: Database, userId: string): Promise<Result<Dek, VaultStorageError>>;
  /** Unpair: deletes the key. */
  delete(db: Database, userId: string): Promise<Result<void, VaultStorageError>>;
} as const;

// key-slot.ts: OAuth credentials (authorization codes, refresh tokens); no DEK
export const KeySlot = {
  mint(config, { userId, kind, grantId, payloadJson, expiresAt }): { values: NewKeySlot; credential: SlotCredential };
  /** The row if the credential is genuine and usable (kind, user, verifier, not revoked/consumed/expired). */
  open(db, config, { credential, kind, userId? }):
    Promise<Result<KeySlotRow, KeySlotInvalidError | KeySlotConsumedError | VaultStorageError>>;
} as const;

export const Vault = {
  /** Unpair/delete: delete every slot and grant of the user. */
  revokeAll(db: Database, userId: string): Promise<Result<void, VaultStorageError>>;
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
// context.ts (tools unlock the DEK with ServerKey when they need data)
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
`deleteUserData(db, userId)` (no DEK needed: deletes rows). The DEK always
comes from `ServerKey.unlock`. Background work: `FirstSync.run` (the backfill
after pairing, holding the pairing's lease, progress in server memory) and
`BackgroundSync` (incremental sync of every paired user each minute, started
from `src/instrumentation.ts`).

DataBox AAD conventions (both sides must agree):
- `gm_session.auth_data_enc`: `{ userId, table: "gm_session", rowKey: userId, column: "auth_data" }`
- `conversation.content_enc`: `{ userId, table: "conversation", rowKey: conversationId, column: "content" }`
- `message.content_enc`: `{ userId, table: "message", rowKey: messageId, column: "content" }`
