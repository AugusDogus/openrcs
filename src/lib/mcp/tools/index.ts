import type { RcsToolRegistrar } from "@/lib/mcp/context";
import { registerGetStatusTool } from "./get-status";

/** Every tool exposed by the openrcs MCP server. Add new tools here, one file each. */
export const rcsTools: readonly RcsToolRegistrar[] = [registerGetStatusTool];
