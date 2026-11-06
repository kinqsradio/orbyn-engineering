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

The crate's [group table](../../README.md#groups) lists every group.
