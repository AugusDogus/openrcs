# Connecting agents

The MCP endpoint is shown on the dashboard with a copy button:

```
https://<machine>.<tailnet>.ts.net:5443/api/mcp
```

The agent must run on a device in your tailnet. When it connects, it opens
openrcs in your browser and you approve it there. Revoke any agent from the
dashboard.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http openrcs <url>`, then `/mcp` in Claude Code to sign in |
| Codex | `codex mcp add openrcs --url <url>` (run `codex mcp login openrcs` to sign in again) |
| OpenCode | `opencode mcp add openrcs --url <url>`, then `opencode mcp auth openrcs` |
| Cursor and other JSON-configured clients | `{ "mcpServers": { "openrcs": { "url": "<url>" } } }` |
| [Executor](https://executor.sh) | Import openrcs as a custom app from its MCP URL, then approve the OAuth sign-in |

Agents sign in with OAuth 2.1 (dynamic client registration and PKCE). There
are no API keys.

## Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `get_status` | either | Whether the phone is paired, when it last synced, how much is stored |
| `list_conversations` | `messages:read` | Conversations, most recent first, optionally filtered by name or number |
| `get_messages` | `messages:read` | One conversation's messages, paged |
| `search_messages` | `messages:read` | Full-text search, optionally by conversation and date range |
| `get_media` | `messages:read` | An attachment: images inline, other files as a download link valid for 10 minutes |
| `list_contacts` | `messages:read` | Contacts from the phone, to find a number to text |
| `sync_messages` | `messages:read` | Pull more history from the phone now |
| `send_message` | `messages:send` | Send a text from your phone |

Reading and searching check the phone for new messages first and fall back
to stored messages when the phone is unreachable.
