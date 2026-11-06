# orbynd

The local service and command line: transport over
[orbyn-core](../orbyn-core/README.md), with no product rules of its own.

## Contract

| Binary | Role |
| --- | --- |
| `orbynd` | HTTP, SSE and WebSocket API, the static UI, access control |
| `orbyn` | The command line; it calls a running service through the same API as the UI |
| `orbyn-fake-engine` | A deterministic protocol double for tests; never shipped as an engine |

## Consumers

- `web`, over the HTTP API and streams.
- `desktop/src-tauri`, which starts `orbynd` as a process.
- People and scripts, through `orbyn`.

## Tests

`tests/` drives the real service against the fake engine, one file per area.

## Known limitations

- It binds to loopback unless started with `--remote`, which needs
  `--tls-terminated`: TLS comes from Tailscale, SSH or a proxy, never from
  `orbynd` itself.
- The fake engine's frames are written by hand from each engine's schema, not
  recorded from live engines.
