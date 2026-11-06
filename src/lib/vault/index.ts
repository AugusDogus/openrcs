export { Base64Url } from "./base64url";
export { VaultConfig, type DeviceCookieSettings } from "./config";
export { DataBox, DataBoxOpenError, DataBoxSchemaError, type DataBoxAad } from "./data-box";
export { Dek } from "./dek";
export { DEVICE_COOKIE, DeviceCookie, DeviceUnlock } from "./device";
export {
  KeySlotConsumedError,
  KeySlotInvalidError,
  VaultLockedError,
  VaultStorageError,
  type KeySlotRejection,
} from "./errors";
export { KeySlot, SlotCredential, type KeySlotRow, type NewKeySlot } from "./key-slot";
export { PairingKeys, type PairingKeyMode, type PreparedPairingKey } from "./pairing-keys";
export { Vault } from "./vault";
