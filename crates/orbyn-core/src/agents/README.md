# Agents

Everything about the coding engines Orbyn runs: which exist, how to talk to each, and what they keep on their own.

| Module | Owns |
| --- | --- |
| `engines` | Engine registry, status and updates through the installer that owns each binary |
| `driver` | One driver per engine protocol, turning it into `EngineEvent`s |
| `acp_registry` | The public ACP agent registry and installing an agent as a custom engine |
| `acp_mcp_bridge` | Stdio access to a run's MCP endpoint for ACP agents |
| `native_sessions` | An engine's own saved conversations: list, import, delete |
| `claude_history` | One Claude conversation read from Claude's history folder |
| `history_import` | Claude and Codex conversations imported as threads |
| `console` | The engine's own console resumed in an Orbyn terminal |
| `permission_modes` | Which permission modes each provider offers |
| `selection` | Model, effort and options a turn asks of its engine |
| `usage` | Usage from each engine's local session history |
| `triage` | A fresh native support session outside governed runs |
| `sse` | An incremental `text/event-stream` parser |
| `titles` | Thread titles from a short engine call |

The crate's [group table](../../README.md#groups) lists every group.
