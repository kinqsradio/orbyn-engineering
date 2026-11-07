# Tools

What a running agent can call: Orbyn's per-run MCP server, its tools and the skills library.

| Module | Owns |
| --- | --- |
| `mcp` | The per-run MCP server behind a random per-run token |
| `mcp_tools` | Orbyn's own tools for a running agent |
| `mcp_apps` | MCP Apps: a tool's `ui://` page shown beside its row |
| `skills` | Skills read in place from the workspace library |
| `claude_skills` | Claude Code's own skills, where its CLI reads them |
| `workflow_scripts` | The script a Claude Code workflow runs, for display |

`claude_skills` discovers Claude Code skill names and resolves its configuration
directory. The conversation composer uses discovery, and `workflow_scripts` uses
the configuration directory to locate scripts. The Claude-specific format does
not make this part of engine session lifecycle.

The crate's [group table](../../README.md#groups) lists every group.
