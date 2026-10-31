# Orbyn Engineering app architecture

Orbyn Engineering is a local-first workbench that wraps coding-agent CLIs in
Orbyn skills and per-session governance. Desktop and web are both clients of one
core service. The product never proxies model traffic and never reads engine
credentials.

## Owners

| Owner | Path | Owns |
| --- | --- | --- |
| Wire contract | `crates/orbyn-contracts` | Serialized types shared with the UI; generated TS in `web/src/generated` |
| Core | `crates/orbyn-core` | Store, run lifecycle, policy, audit, skills, engines, git, terminal, computer gateway |
| Service | `crates/orbynd` | HTTP/SSE/WebSocket transport, static UI, access control, CLI entry point |
| UI | `web` | Task flows only; it holds no authority and no lifecycle rules |
| Desktop shell | `desktop/src-tauri` | Spawns `orbynd`, loads its loopback URL, tray and app updates |

Dependency direction: `orbynd -> orbyn-core -> orbyn-contracts`. The UI depends
only on generated types and the HTTP API. Nothing in `web` may import Tauri APIs.

## Hard product rules

1. Engines keep their own login. Orbyn runs the unmodified CLI, shows status and
   opens the vendor's own sign-in flow. It never reads, stores or forwards tokens.
2. The Codex driver never calls `account/login/*`. It reads `account/read` only.
3. Claude uses the CLI, never the Agent SDK. `--bare` is forbidden on subscription
   sessions because it ignores OAuth login.
4. Orbyn writes nothing into target repositories or engine user config for skills.
5. A folder must be trusted before any engine runs in it, because `claude -p`
   runs repo hooks and `.mcp.json` without its own trust dialog.
6. Audit rows are written before the effect they describe, and are append-only.
7. Anything unknown fails closed: an unreachable approver means deny.
8. An engine that cannot ask permission is labelled unmanaged in every surface.
9. Update only through the installer that provably owns the binary; otherwise
   show manual instructions. Never update during an active run.

## Run lifecycle

```text
admitted -> starting -> running <-> awaiting_approval
                           |              |
                           v              v
                 completed | failed | cancelled | interrupted
```

- `admitted` is durable before any process spawns. One active run per thread;
  a second admission returns `409 thread_busy`.
- `interrupted` is assigned only by startup recovery, for runs a dead process
  owned. Recovery also moves pending approvals to `expired`.
- Terminal states never change. Every transition is a compare-and-set on the
  previous state, so a late engine event cannot revive a finished run.
- A run owner is fenced by `(run_id, owner_epoch)`. `owner_epoch` is a value
  chosen at process start; a stale owner's writes are rejected.
- A file lock gives each data directory one live `orbynd`, because a second
  process's recovery would fence runs that are still alive.
- Pending approvals expire in the same transaction that ends a run.

## Approval lifecycle

```text
pending -> allowed | denied | expired
```

The first decision wins by compare-and-set. A duplicate decision returns the
existing outcome with `409 already_decided`. Run cancellation and driver exit
expire open approvals, and the engine receives a denial. Policy is evaluated
first: `deny` wins over `ask`, `ask` wins over `allow`, and no matching rule means
`ask`. A timed-out approval expires and denies. A wildcard `allow` on a `command`
never matches a compound command (`;`, `|`, `&`, redirection, substitution), so
`git *` cannot grant `git log; rm -rf /`. `remember` stores an exact rule, written
`=<target>`, so a target containing `*` does not become a wildcard.

## Event stream

Every run event is stored in `thread_events` with a per-thread `seq`, and followers
are woken after commit. A follower carries only a position and always reads from
the log, so replay and live are one loop. `GET /api/threads/:id/events` is SSE: it
replays from `Last-Event-ID`, then follows live. Events use AG-UI 1.0 names.
Delivery to clients is a projection of the log; a client that reconnects loses
nothing.

Activity types are `approval` (content is the `Approval`), `plan`
(`{steps: [{title, status}]}`), `diff` (`{files: [{path, additions, deletions}]}`)
and `unmanaged`. `CUSTOM` carries `tool.output`, `engine.warning` and
`engine.retrying`. The prompt is logged as a `user` text message whose id ends in
`:prompt`.

The AG-UI interrupt model ends a run at an interrupt, while a CLI blocked on
approval stays alive. The native client therefore sees an approval as an
`ACTIVITY_SNAPSHOT` with `activityType: "approval"` during a run. The external
endpoint `POST /agui/threads/:id` projects the same pause as
`RUN_FINISHED(outcome: interrupt)` and maps `resume[]` to approval decisions while
holding the engine process. A resume must answer every open interrupt, replaying
one is safe, and new input on a paused thread gets `RUN_ERROR`. `payload.approved`
carries the decision and anything but `true` denies.

## Driver contract

`EngineDriver` in core declares `EngineDescriptor` (identity, tier, capabilities)
and implements `probe`, `update_plan` and `start_run`. A driver turns one engine's
protocol into `EngineEvent`s and answers `PermissionRequest`s. Drivers hold no
store, policy or UI logic. Tiers: `native` (Claude, Codex), `acp` (one shared
driver), `agui` (one shared driver, also the OpenBot connector) and `terminal`
(PTY only, always unmanaged).

Skill delivery order: native plugin, native skill root, MCP skill server, prompt
bootstrap. A driver declares what it supports and core chooses the first match.
Packs are built into app data with root and per-skill license notices, and each
use re-verifies the ed25519-signed manifest and every file. A pack that fails
verification stops the run. The signing key sits beside the pack, so this catches
changes by anything that cannot read the key, not a process running as the user.

- Claude: `--plugin-dir <pack>/claude-plugin`, per-thread `--mcp-config`,
  `--permission-prompt-tool mcp__orbyn__approve`.
- Codex: `skills/extraRoots/set`, per-thread `mcp_servers.orbyn` config,
  app-server approval requests.

## Per-thread MCP server

`orbynd` serves MCP over streamable HTTP at `/mcp/:thread_token`. The token is
random per run, is passed only to that run's engine, and is revoked at run end.
Tools: `approve` (Claude permission prompt), `skill_search`, `skill_load`, and the
governed `computer_*` tools. `approve` is listed only for Claude.

## Computer gateway

The order is fixed: resolve the target, evaluate policy, write audit, act. Browser
page actions resolve to the current page URL, so rules match where the action
lands. An action with no active run cannot wait for a person, so `ask` refuses and
only an explicit allow rule passes.

## Service access

- Binds `127.0.0.1` by default on a random port. A per-launch token is required
  on every `/api`, `/agui` and `/ws` route.
- `Host` must be a loopback name or a configured host (DNS rebinding defence), and
  a present `Origin` must match it.
- Non-loopback binds need `--remote`, a persisted hashed access key, and
  `--tls-terminated` to assert that Tailscale, SSH or a proxy provides transport
  security. Browsers exchange the key for an `HttpOnly`, `SameSite=Strict` cookie.
- The key is shown once, as `access_key` on the first remote start's JSON line.
- `Secure` is added when a proxy reports `X-Forwarded-Proto: https`; Tailscale and
  SSH tunnels are not HTTPS, so it cannot be unconditional.

## Persistence

SQLite in WAL mode in the OS app-data directory. Migrations are ordered and
forward-only, applied in a transaction at startup, and recorded in
`schema_migrations`. A database from a newer version is refused, not opened.

Secret files are created with mode `0600` on Unix. Windows has no mode bits: they
inherit the ACL of the per-user `%LOCALAPPDATA%` directory, which excludes other
non-administrator users. Orbyn does not set its own ACL.

## Service configuration

`orbynd serve` takes `--port`, `--data-dir`, `--ui-dir`, `--skills-dir`, `--remote`,
`--tls-terminated`, `--allowed-host` and `--parent-stdin`, and prints one JSON line
`{url, token}` on stdout once it can serve. Environment: `ORBYN_SKILLS_DIR`,
`ORBYN_CLAUDE_BIN`, `ORBYN_CODEX_BIN`, `ORBYN_CODEX_SANDBOX` (default
`workspace-write`), `ORBYN_APPROVAL_TIMEOUT_SECS` (default 1800),
`ORBYN_AGENT_DESKTOP`, `ORBYN_BROWSER`, `ORBYN_BROWSER_HEADLESS`, `ORBYN_OFFLINE`
(skip latest-version lookups) and `ORBYN_LOG`.

## HTTP API

All bodies are JSON and errors are `ApiError` with a stable `code`. Auth is
`Authorization: Bearer <token>`, or the session cookie. SSE and WebSocket also
accept `?token=` because browsers cannot set headers on them.

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | `ServerInfo` |
| `GET, POST /api/projects`, `POST /api/projects/:id/trust` | Projects and folder trust |
| `GET /api/fs/browse?path=` | `FsListing` for the folder picker; no `path` means home |
| `GET /api/threads?project_id=`, `POST /api/threads`, `GET, DELETE /api/threads/:id` | Threads |
| `POST /api/threads/:id/runs` | Admit a run (`202`, `409 thread_busy`, `403 folder_untrusted`) |
| `POST /api/runs/:id/cancel` | Cancel |
| `GET /api/threads/:id/events` | SSE `ThreadEvent`, resumes from `Last-Event-ID` |
| `GET /api/approvals?state=pending`, `POST /api/approvals/:id/decide` | Approvals |
| `GET /api/threads/:id/diff` | `FileDiff[]` |
| `GET /ws/terminal/:thread_id` | PTY: binary in/out, JSON text frame `{cols,rows}` resizes |
| `GET /api/engines`, `POST /api/engines/refresh` | `EngineStatus[]` |
| `POST /api/engines/:id/update` | Run the owning installer (`409 engine_busy`) |
| `POST, DELETE /api/engines/custom[/:id]` | ACP, AG-UI and terminal engines |
| `GET /api/skills`, `POST /api/skills/rebuild` | Skill pack |
| `GET, POST /api/skills/profiles`, `DELETE /api/skills/profiles/:id` | Profiles |
| `GET, POST /api/policy/rules`, `DELETE /api/policy/rules/:id` | Policy |
| `GET /api/audit?thread_id=&limit=` | Audit, newest first |
| `GET /api/computer`, `POST /api/threads/:id/computer` | Status, and a governed action |
| `POST /auth/session` | Exchange a remote access key for a cookie (`204`) |
| `POST /agui/threads/:id` | External AG-UI endpoint (`RunAgentInput` in, SSE out) |
| `POST /mcp/:thread_token` | Per-run MCP server |
