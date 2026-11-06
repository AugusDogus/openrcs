import { createSecretKey } from "node:crypto";
import { Result, TaggedError } from "better-result";
import type { z } from "zod";
import { SecretBox } from "@/lib/secret-box";
import type { Dek } from "./dek";

/**
 * Per-user encryption of stored content with the user's DEK (AES-256-GCM).
 * Envelope: "d1.<base64url iv>.<base64url ciphertext || tag>". The associated
 * data binds the envelope to its owner and location so a ciphertext copied to
 * another user, table, row or column fails to open.
 */

const VERSION = "d1";

/** Where an envelope lives. Conventions per table are in docs/vault-contract.md. */
export type DataBoxAad = {
  readonly userId: string;
  readonly table: string;
  readonly rowKey: string;
  readonly column: string;
};

/** The envelope is malformed, or was sealed with another DEK or for another location. */
export class DataBoxOpenError extends TaggedError("DataBoxOpenError")<{
  reason: "malformed" | "authentication";
  table: string;
  column: string;
  rowKey: string;
  message: string;
}> {}

/** The envelope opened but its JSON does not match the expected shape. */
export class DataBoxSchemaError extends TaggedError("DataBoxSchemaError")<{
  table: string;
  column: string;
  rowKey: string;
  /** Issue paths and codes only, never values. */
  issues: readonly string[];
  message: string;
}> {}

/**
 * Canonical AAD: a JSON array in fixed field order. JSON string escaping makes
 * the encoding injective, so no two different locations share an AAD.
 */
const encodeAad = (aad: DataBoxAad): string =>
  JSON.stringify([aad.userId, aad.table, aad.rowKey, aad.column]);

const boxFor = (dek: Dek): SecretBox => ({ key: createSecretKey(dek.bytes) });

const where = (aad: DataBoxAad) => `${aad.table}.${aad.column} (row ${aad.rowKey})`;

const seal = (dek: Dek, plaintext: string, aad: DataBoxAad): string =>
  SecretBox.seal(boxFor(dek), plaintext, { associatedData: encodeAad(aad), version: VERSION });

const open = (dek: Dek, envelope: string, aad: DataBoxAad): Result<string, DataBoxOpenError> =>
  SecretBox.open(boxFor(dek), envelope, { associatedData: encodeAad(aad), version: VERSION }).mapError(
    (error) =>
      new DataBoxOpenError({
        reason: error._tag === "SecretBoxFormatError" ? "malformed" : "authentication",
        table: aad.table,
        column: aad.column,
        rowKey: aad.rowKey,
        message:
          error._tag === "SecretBoxFormatError"
            ? `Cannot decrypt ${where(aad)}: the stored envelope is malformed (${error.reason}). The row was not changed; it is unreadable until it is re-synced from the phone.`
            : `Cannot decrypt ${where(aad)}: it was sealed with a different key or for a different row, or it was modified. The row was not changed; if the key was rotated by re-pairing, re-sync from the phone.`,
      }),
  );

const sealJson = (dek: Dek, value: unknown, aad: DataBoxAad): string =>
  seal(dek, JSON.stringify(value), aad);

const openJson = <T>(
  dek: Dek,
  envelope: string,
  aad: DataBoxAad,
  schema: z.ZodType<T>,
): Result<T, DataBoxOpenError | DataBoxSchemaError> =>
  open(dek, envelope, aad).andThen((text): Result<T, DataBoxOpenError | DataBoxSchemaError> => {
    const schemaError = (issues: readonly string[]) =>
      new DataBoxSchemaError({
        table: aad.table,
        column: aad.column,
        rowKey: aad.rowKey,
        issues,
        message: `Decrypted ${where(aad)} does not have the expected shape (${issues.join("; ")}). The row was not changed; re-sync it from the phone.`,
      });
    const json = Result.try({
      try: (): unknown => JSON.parse(text),
      catch: () => schemaError(["(root): not valid JSON"]),
    });
    if (json.isErr()) return Result.err(json.error);
    const parsed = schema.safeParse(json.value);
    if (parsed.success) return Result.ok(parsed.data);
    return Result.err(
      schemaError(
        parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`,
        ),
      ),
    );
  });

export const DataBox = {
  seal,
  open,
  sealJson,
  openJson,
  encodeAad,
} as const;
