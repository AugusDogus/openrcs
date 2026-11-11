import type { RcsToolRegistrar } from "../context";
import { registerGetMediaTool } from "./get-media";
import { registerGetMessagesTool } from "./get-messages";
import { registerGetStatusTool } from "./get-status";
import { registerListContactsTool } from "./list-contacts";
import { registerListConversationsTool } from "./list-conversations";
import { registerSearchMessagesTool } from "./search-messages";
import { registerSendMessageTool } from "./send-message";
import { registerSyncMessagesTool } from "./sync-messages";

/** Every tool exposed by the openrcs MCP server. Add new tools here, one file each. */
export const rcsTools: readonly RcsToolRegistrar[] = [
  registerGetStatusTool,
  registerListConversationsTool,
  registerGetMessagesTool,
  registerGetMediaTool,
  registerSearchMessagesTool,
  registerSendMessageTool,
  registerListContactsTool,
  registerSyncMessagesTool,
];
