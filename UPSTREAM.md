# Upstream

Orbyn Engineering is original code. This file lists the outside programs,
protocols and packages the app runs, implements or ships, with their licenses, and
how we keep each one current.

## Protocols we implement

| Protocol | Source | Where |
| --- | --- | --- |
| AG-UI 1.0 event names | [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui), MIT | The event stream, and the AG-UI driver that also connects OpenBot. |
| Agent Client Protocol | [agentclientprotocol.com](https://agentclientprotocol.com) | The ACP driver and the ACP agent registry. |
| Model Context Protocol | [modelcontextprotocol.io](https://modelcontextprotocol.io) | The per-run MCP server, `orbyn_engineering`. |

## Programs we run but do not ship

The app starts these as separate, unmodified programs that you install yourself.
Each keeps its own login and license.

| Program | Used for |
| --- | --- |
| [Claude Code](https://github.com/anthropics/claude-code) CLI | The Claude driver, through `stream-json`. |
| [Codex](https://github.com/openai/codex) CLI | The Codex driver, through `codex app-server`. |
| ACP and AG-UI agents, such as [OpenBot](https://github.com/CopilotKit/openbot) | Any agent you add as a provider instance. |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop), Apache-2.0 | The optional computer gateway, when it is on your `PATH` or set in `ORBYN_AGENT_DESKTOP`. |
| Git and GitHub CLI | Source control and pull requests. |

## What we ship

| Component | License | Pinned in |
| --- | --- | --- |
| [orbyn-fullstack-skills](https://github.com/orbyn-dev/orbyn-fullstack-skills) snapshot | MIT, with its `LICENSE` inside and beside the bundle | [scripts/library.lock](scripts/library.lock) |
| Rust crates | Their own licenses | `Cargo.lock`, `desktop/src-tauri/Cargo.lock` |
| npm packages | Their own licenses; see [web/NOTICE](web/NOTICE) | `web/package-lock.json`, `desktop/package-lock.json` |

## Keeping up

- **The skills library.** Change the commit in `scripts/library.lock` to a merged
  library commit. Start the service on a fresh data folder with the new bundle and
  confirm it provisions with no problem. Label the pull request `area: library`.
- **Engines.** Users update their engines from the app. When an engine changes its
  protocol, fix the driver and name the engine version you tested in the pull
  request, with the engine label.
- **Protocols.** When a protocol publishes a new version, update the driver and
  this table in the same pull request.
- **Dependencies.** Dependabot handles these; see
  [CONTRIBUTING.md](CONTRIBUTING.md#dependencies).
