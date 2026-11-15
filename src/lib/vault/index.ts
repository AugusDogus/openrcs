export { Base64Url } from "./base64url";
export { VaultConfig } from "./config";
export { DataBox, DataBoxOpenError, DataBoxSchemaError, type DataBoxAad } from "./data-box";
export { Dek } from "./dek";
export {
  KeySlotConsumedError,
  KeySlotInvalidError,
  VaultStorageError,
  type KeySlotRejection,
} from "./errors";
export { KeySlot, SlotCredential, type KeySlotRow, type NewKeySlot } from "./key-slot";
export { ServerKey, ServerKeyInvalidError } from "./server-key";
export { Vault } from "./vault";
