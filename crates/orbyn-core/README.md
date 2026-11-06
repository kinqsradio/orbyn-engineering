# orbyn-core

All product behaviour: what Orbyn decides and every effect it has. Transport lives
in [orbynd](../orbynd/README.md). The rules that govern this crate are in
[docs/architecture.md](../../docs/architecture.md).

## Contract

`Core` and `CoreConfig` (from `app`) assemble the service, and `CoreError` (from
`error`) carries each failure's stable client code. Every other public item is
reached through its group, for example `orbyn_core::source_control::git`.

## Consumers

- `orbynd`: the HTTP API, streams, CLI and its integration tests.

## Groups

Each folder under `src/` owns one capability. A new module joins an existing
group; a new group adds its own `README.md` and a row here.

| Group | Owns |
| --- | --- |
| [agents](src/agents/README.md) | Engine registry, drivers, engine sessions and history, model selection, usage |
| [conversation](src/conversation/README.md) | Threads and runs: admission, composer, questions, checkpoints, changes, automations, published pages, search |
| [governance](src/governance/README.md) | Policy, the approval gate, the computer gateway and the outbound request list |
| [project](src/project/README.md) | Projects, the managed workspace, project files, icons and images, setup, checkout files |
| [source_control](src/source_control/README.md) | Git, Jujutsu, forge CLIs, commit text and review guides |
| [browser](src/browser/README.md) | Preview tabs, their bridge, recordings and remote images |
| [tools](src/tools/README.md) | The per-run MCP server, Orbyn's agent tools, MCP Apps and skills |
| [settings](src/settings/README.md) | Preferences, keybindings and the environment's published identity |
| [operations](src/operations/README.md) | Diagnostics, local traces, telemetry export, maintenance and updates |
| [host](src/host/README.md) | Child processes, inherited environment, terminals and the desktop shell bridge |

Shared by every group, at the crate root: `app` (assembly), `error`, `store`
(durable state), `util` and `testing` (unit-test helpers).

Before a group calls into another, check that the decision belongs to the group
being called, not the caller.

Three shared capabilities keep their current decision owners:

- [`project::workspace`](src/project/README.md): library lifecycle and project
  boundaries, including coordination with run admission.
- [`tools::claude_skills`](src/tools/README.md): skill discovery for the composer
  and configuration-directory lookup for workflow script display.
- [`browser::remote_images`](src/browser/README.md): remote raster fetch policy
  shared by thread media and browser history icons.

## Known limitations

- Groups are an ownership map, not layers. Today they call each other in both
  directions (`agents` and `conversation`, for example), and only the crate-level
  direction `orbynd -> orbyn-core -> orbyn-contracts` is enforced.
- Groups are folders, not crates. Rust visibility does not stop one group from
  using another's `pub` items.
- `app` and `store` are used by nearly every group. They are the crate's
  assembly and persistence owners, not groups of their own.
- Unit tests stay inside their modules (`mod tests` or a `tests.rs` beside them),
  as Rust expects. Cross-crate behaviour is tested from `crates/orbynd/tests`.
