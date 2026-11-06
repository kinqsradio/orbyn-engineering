# Crates

Each crate has one role. Dependencies point one way:
`orbynd -> orbyn-core -> orbyn-contracts`.

| Crate | Role | Owns |
| --- | --- | --- |
| [orbyn-contracts](orbyn-contracts/README.md) | Contract | Wire types shared with the UI; generates `web/src/generated` |
| [orbyn-core](orbyn-core/README.md) | Provider | Every product rule and effect, grouped by capability |
| [orbynd](orbynd/README.md) | Consumer | HTTP, SSE and WebSocket transport, access control and the CLI |

`desktop/src-tauri` sits outside this workspace and depends on none of these
crates. It starts `orbynd` as a process.

A new crate needs its own ownership, distribution or build-isolation reason. A new
capability usually belongs in a group folder inside `orbyn-core` instead.
