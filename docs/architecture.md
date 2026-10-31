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
| Workspace | `crates/orbyn-core` `workspace`, `projects` | Library checkout, target boundaries, library updates, project intake |
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
4. Orbyn writes nothing into target repositories or engine user config: no skills,
   instructions, excludes or context maps. The project file is read-only to Orbyn.
5. A folder must be trusted before an engine, project script or terminal runs in
   it, and a folder added by path starts untrusted. Claude 2.1.150 run at the
   library with `--add-dir <checkout>` loads the checkout's skills but not its
   `.mcp.json` or hooks: both fired from the cwd and neither through `--add-dir`. Its
   `CLAUDE.md` was not observed either way, and an engine still acts on the target,
   so trust stays the gate.
6. Audit rows are written before the effect they describe, and are append-only.
   Policy and audit are internal safety, not a user feature.
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

## Thread lifecycle

Settling removes a pin and ends a snooze; it needs no active run and closes the
thread's terminals. Un-settling returns a thread to the top and holds off automatic
settling until new activity. Archiving hides a thread and refuses new runs. Your
message, an approval request and a run ending all wake a snoozed thread; those
wakes share the transaction that caused them. Thread activity never changes the
saved order. A running thread or descendant is never settled automatically or
deleted. Lifecycle changes are logged as `CUSTOM thread.updated`.

## Composer

A queued message becomes a run in one transaction, so it cannot start twice or
vanish. A run ending in anything but success holds the queue until a resume, and
new messages join a held queue; recovery holds it too. `send-now` puts one message
first and stops the running turn, and only that message escapes the hold. Prompts
are capped at 120,000 characters. `/compact` and `/goal` reach Claude bare as its
own commands and Codex as `thread/compact/start` and `thread/goal/set`.

A goal is set with `/goal <text>` and ended with `/goal clear`. `/goal pause` and
`/goal resume` are refused with `422 unsupported` on an engine without
`goal_control`, which today is every engine but Codex, whose status changes go
through `thread/goal/set`. Claude's goal lives in its own session, so only
Codex's status is reported back; the rest show what was last asked for.

A thread's permission mode is `supervised`, `auto_edits`, `auto` or `full_access`,
settable per thread and per turn. Codex maps it natively: `full_access` is
`approvalPolicy: never` with the network on, and the writable root stays the checkout.
Claude stays on `--permission-mode default` and the gate accepts for it, because
`acceptEdits` trusts its cwd, which is the library, and `bypassPermissions` skips
`mcp__orbyn_engineering__approve`, so either would defeat the write scope. A rule
still wins, computer and browser actions still ask, and the write scope is checked
first. Plan mode refuses file changes, runs Claude in `plan` and Codex read-only.

Attachments stay in app data, never in a target, and are removed with their thread.
The limits are 100 per thread, 10 MiB per image, 80 MiB of images and 50 MiB per other
file. A record exists only once its bytes are in place, and a message naming an
attachment that is not ready is refused before anything is admitted.

## Models

`GET /api/engines/:id/models` comes from the engine where it can say: Codex's
`model/list` on a short-lived app-server, or the models an ACP agent reports for a
session opened in a temp folder with no prompt sent. Claude's CLI has no listing, so
its list is the aliases its documentation names, marked `documented`. A good answer
is kept for five minutes, and a failure is reported with the list empty rather than
as an error. `effort` reaches Claude as `--effort` and Codex on `turn/start`; `model`
and `effort` set on a turn stay on the thread.

## Questions

An engine question holds its run in `awaiting_approval` until it is answered,
dismissed, timed out or the run ends, and all of those close it. A run returns to
`running` when no approval and no question is open. Codex's
`item/tool/requestUserInput` and Claude's `AskUserQuestion` both arrive here; Claude's
goes through the same `approve` callback, so it stays on the MCP gate. A dismissal
reaches Codex as an empty answer set and Claude as a denial. Questions are logged as
`ACTIVITY_SNAPSHOT` with `activityType: "question"`, whose content is the
`QuestionRequest`. A secret answer goes to the engine and is stored only as
`[hidden]`, so it never reaches the database or the event log.

## Session recovery

An engine that no longer has the session a run tried to resume reports
`SessionLost`, not a failure. The run stays open, the session is dropped, the handoff
is rebuilt from the log with the same 16,000 character budget, and the engine starts
fresh once, logging `CUSTOM engine.session_lost`. A second loss fails the run.

## Usage

`UsageCenter` reads local session history and nothing else: `projects/**/*.jsonl`
under `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `sessions/**/*.jsonl` under `~/.codex`
(or `CODEX_HOME`). It keeps only timestamps, models and token counts, and never opens a
credential file. Claude rewrites an entry as it streams, so each message counts once.
Codex repeats its running total, so an unchanged total counts once. Costs come from
configured `model_prices`, after `model_aliases`; a model with no price has an unknown
cost and is never guessed. Unchanged files are served from memory. Subscription
limits appear only where an engine reports them itself, as Codex does through
`account/rateLimits/read`, cached for five minutes; `?force=true` reads again and
spends no model usage. `/api/limits` also gives one number per window length across
engines, the highest used percentage, since that engine stops first.

## Checkpoints

Each run snapshots the checkout before it starts and when it ends, through a
temporary index, into `refs/orbyn/checkpoints/<thread>/<run>/{start,end}`. The real
index, HEAD and working files stay untouched, ignored files are not captured, and a
failed snapshot costs that checkpoint, not the run. This Git metadata is the one
thing a run adds under a target, in that repository's own `.git`, whether it was
cloned here or registered in place, and removing a project leaves it there. It never
reaches a working file or a push.

Restoring takes a safety snapshot first, then makes the files match, leaving HEAD,
the index and ignored files alone. It refuses while another live thread shares the
folder. A rewind, a fork and an engine switch cannot carry an engine session, so each
ends it and leaves a handoff of up to 16,000 characters, oldest text dropped first,
that goes to the next run once. The log stays whole; a rewind is logged as `CUSTOM
thread.rewound` for clients to hide what follows. Native rollback (`thread/revert`)
is not used.

## Source control

Forge work goes through the forge's own CLI, chosen from the origin host: `gh`,
`glab`, `az` and `tea`. Orbyn holds no forge credential and reads none, so an unknown
host is treated as GitHub Enterprise through `gh`, and a missing CLI is
`422 unsupported`. Bitbucket has no CLI to go through and needs an API token, so it
reports that and stays `422`. GitHub and GitLab cover the full pull request surface
through `gh api` and `glab api`. Azure DevOps and Forgejo cover list, read, open,
merge, close and reopen; anything else is `422`. Arguments are passed directly and no
shell parses them, and comment and thread ids that go into API paths are checked to
be plain.

A git action runs commit, push and pull request in order, logs each phase as `CUSTOM
git.phase`, and stops at the first failure; earlier phases stand. These are the
user's own commands, so unlike Orbyn's internal reads they run commit hooks. All of
it needs a trusted folder, and writes wait for the thread's run to end. Every forge
write is audited before it happens. A stack is the chain of open pull requests whose
bases are each other's heads; a stack action works from the bottom and stops at the
first failure. Bulk close carries on past a refusal and reports each number.

Linked pull requests are polled every two minutes, and a refresh links the open pull
request of the checkout's branch. A merge settles the thread when `on_merge` is set
and the thread has not opted out. A watch wakes its thread, through the queue, when a
check fails, all checks pass, the branch starts to conflict, or someone else comments
or reviews; the viewer's own comments are not news. It ends at a merge or close, after
10 wakes in a row that bring only comments, after 8 failed reads in a row, on an
unlink, or when the thread settles or archives. A subagent thread cannot watch.
Viewed-file marks are this service's own, per project, and never reach the forge.

A background clone is a job kept in memory until the service stops. Its staging
folder removes itself when the job is cancelled. An SSH URL the server refuses is
tried once over HTTPS, and the job says so.

## Terminals

A thread holds up to 32 terminals, each with 5,000 lines and 8 MiB of scrollback kept
here. Terminals sharing a `group` are a split. The `main` terminal is what a plain
socket opens and a terminal-tier run uses, and a plain one nobody returns to closes
after a minute. Named terminals stay until closed. Settling or archiving closes them
all. `?observe=true` attaches read-only: input and resizes are dropped. Fish starts
with `no-query-term` so it does not wait on terminal replies.

The project file is `orbyn.json`, or `t3.json` when a repository already has one, at
the checkout's root. Orbyn only reads it, and a bad file is reported and never half
applied. A script runs in its own terminal through the login shell, or `cmd /C` on
Windows. The command comes from the file, never the request, and it needs a trusted
folder. `run_on_worktree_create` and `run_on_settle` scripts run only in a worktree;
one that cannot start is logged and does not undo the change that triggered it, and
Orbyn does not hold a run for a setup script to finish.

## Files

File routes need a trusted folder and share the engines' write scope, so `..` and
symlinks cannot leave the checkout, and `.git` is out of reach. A save names the
revision it started from; a file that moved on is reported, never overwritten, and
new bytes arrive by rename. These saves are the user's own edits, audited, and
differ from rule 4, which covers what Orbyn adds on its own.

## Approval lifecycle

```text
pending -> allowed | denied | expired
```

The first decision wins by compare-and-set. A duplicate decision returns the
existing outcome with `409 already_decided`. Run cancellation and driver exit
expire open approvals, and the engine receives a denial. Policy is evaluated
first: `deny` wins over `ask`, `ask` wins over `allow`, and no matching rule means
`ask`. Policy and audit are internal safety: the product surface is the permission
mode, and no client offers rule editing or an audit log. A timed-out approval expires and denies. A wildcard `allow` on a `command`
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
and `unmanaged`. `question` (content is the `QuestionRequest`), and `CUSTOM` carries `tool.output`,
`tool.finished`, `subagent.activity`, `usage`, `goal.updated`, `engine.warning`,
`engine.retrying` and `engine.session_lost`. The prompt is logged as a `user` text message whose id ends in
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

Skills come from the workspace, in place. Nothing is copied, packed or signed.

- Claude starts at the workspace root and discovers `.claude/skills` and the
  library's `AGENTS.md` natively. It has no `--plugin-dir`, and gets a per-run
  `--mcp-config`, `--permission-prompt-tool mcp__orbyn_engineering__approve` and
  `--add-dir <checkout>`. Its working directory is the library, so a relative path
  means the library, and the bootstrap tells it to use absolute paths and run
  commands from the checkout.
- Codex's process and `thread/start` use the workspace root for `.agents/skills`
  and `AGENTS.md`, and each `turn/start` sets `cwd` and
  `sandboxPolicy.writableRoots` to the selected checkout. The turn's `cwd` must stay
  the checkout: a real 0.166.0 turn against a local stub provider, with no model
  involved, wrote to the checkout and was denied the library, but with the library
  as its `cwd` it wrote to the library and relative paths landed there.
  `command/exec` is not the same: it also let the app-server's own cwd be written,
  and engines do not use it. It has a per-thread `mcp_servers.orbyn_engineering`
  config and app-server approval requests.
- Non-native engines start in the checkout and reach skills through the MCP server,
  or through the skill list in the bootstrap.

## Workspace

There is one managed workspace: a clone of the skills library at `<data>/workspace`
(`--workspace-url`, `ORBYN_WORKSPACE_URL`), cloned with `core.symlinks=true`, or an
existing checkout the user adopts in place and which is never moved. Engines and
projects wait for this step (`409 workspace_required`).

```text
<workspace>/                 library Git root; engines start here
  AGENTS.md, skills/, .claude/skills, .agents/skills
  repo/                      ignored; the default home of cloned and created projects
    <slug>/                  target primary clone
    <slug>-wt/<purpose>/     target worktree on a neutral `feat/<purpose>` branch
<any folder>/                a project registered where it is
<any folder>-wt/<purpose>/   its worktrees
```

Boundaries are checked with Git metadata only and no project code runs. A library
must be a real Git root with `skills/catalog.json` and `AGENTS.md`, and an ignored,
untracked `repo/`.

A project is any folder the person names, registered where it is: nothing is cloned,
moved, copied or written, and it starts untrusted, so trust is a required step.
`POST /api/projects/add` resolves the real path, following links, then the Git root,
which becomes the project. Both must clear the library: the library itself, anything
inside it and any folder containing it are refused, as is a linked worktree of the
library. `repo/` is the exception, and a folder under it still has to meet the nested
rules: its own Git root, its Git data under `repo/`, and ignored by the library. A
folder already registered is `409 project_exists` by its real path, so a link to it
cannot make a second project. A folder outside Git is allowed, and works without
worktrees, diffs, checkpoints or forge features. This differs on purpose from the
library's `workspace.py check --in-place`, which requires a Git root. The same check
runs again before each run, because a folder can change between runs.

Clone and create are the routes that make a folder, at `<workspace>/repo/<slug>` by
default or at a chosen absolute path that holds nothing yet. A clone works in a
staging folder beside its destination. Those projects are `managed`.

Removing a project unregisters it and deletes its threads, and leaves the folder
exactly as it was. `?delete_files=true` is refused for a folder Orbyn did not create.
For one it did, dirty or unpushed work needs `confirm`, and files go only when nothing
is dirty, unpushed, ignored or in a worktree.

Worktrees sit beside the primary clone at `<repo>-wt/<purpose>/`, wherever that repo
lives, on a neutral `feat/<purpose>` branch, and a registered worktree for a purpose
is reused. A custom worktree location is not offered.

A thread with no project gets a dated folder, `<data>/scratch/<date>-<id>`, behind a
hidden project, so it passes through the same trust, write scope and launch as any
other thread. Orbyn made the folder, so it starts trusted. It stays on disk after the
thread is deleted. Until its first run a thread can move to another project or a new
scratch folder, after which `400`. `POST /api/threads/:id/adopt` makes the folder a
project where it is, along with every thread in it.

The library changes only through the app. An update fetches, shows incoming commits
and fast-forwards. It refuses local edits (`409 library_dirty`), active runs
(`409 runs_active`) and diverged history (`409 not_fast_forward`). Local edits are
shown as dirty and never reset. A rollback returns to the revision before the last
update, only from exactly where that update left the library. Admission and a
library move share a lock, so neither can pass the other's check.

Each run's prompt starts with a short context block naming the library path and
revision, the target Git root, the selected checkout, branch and revision, and that
the agent
must read the target's instructions itself because discovery across a Git boundary
is not guaranteed and target rules specialize shared methods. The event log keeps
the user's prompt alone.

A run writes only inside its selected checkout. The gate denies a file change
outside it before policy runs, comparing canonical absolute paths after resolving
`..` and symlinks, so no rule or person can widen it. A relative path is resolved
where the engine resolves it: from the library for Claude and from the checkout for
the others. An approval shows it as an absolute path, so a person sees the real
target. Diffs, checkpoints and file routes always use the thread's checkout. Codex's sandbox enforces the same root. Claude's Bash has no OS sandbox,
so a command is governed by policy and approval, not by this check. The library is
read-only to engines unless a thread is opened on the library's own project, which
needs trust and never reaches `repo/`.

A skill's identity is the library revision plus its dirty flag. Profiles filter what
the MCP server and the bootstrap list. On Windows `.claude/skills` and
`.agents/skills` are Git symlinks; if they did not materialize, status says so and
that session uses the MCP route. The tree is never rewritten.

## Updates

`UpdateCenter` is one view of the skills library, the app and the engines. It checks
at startup, every six hours and on demand, unless the `background_update_checks`
setting is `false`. A check only reads: `git fetch` of the library, engine latest
versions and the app's release. A network failure never blocks startup; it keeps
the earlier results and sets `error`, and `checked_at` stays at the last full
success. Nothing applies automatically, ever.

`POST /api/updates/apply-all` runs engines, then the library, then the app, stops at
the first failure, and is refused while any run is active (`409 runs_active`). Every
applied update is audited. `GET /api/updates/events` sends the status, then each
change, for the UI's badge.

With `--parent-stdin` a desktop shell owns app updates over newline JSON. It sends
`app_update_available`, `app_update_none`, `app_update_unconfigured`,
`app_update_progress` and `app_update_failed` on stdin; unknown or malformed lines
are ignored, and EOF still means shut down. After the ready line `orbynd` sends
`check_app_update` and `install_app_update` on stdout. Install first checks for
active runs and then holds admission (`503 updating`) under the admission lock, until
exit or until the shell reports failure.

With no shell, `--update-manifest` names a release manifest `{version, notes}` to
compare with the running version; with none, the app reports `unconfigured`. A
server cannot replace itself, so `can_apply` stays false and `blocked_reason` says
what to do.

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

`orbynd serve` takes `--port`, `--data-dir`, `--ui-dir`, `--workspace-url`,
`--update-manifest`, `--remote`,
`--tls-terminated`, `--allowed-host` and `--parent-stdin`, and prints one JSON line
`{url, token}` on stdout once it can serve. `--skills-dir` is accepted and ignored
for older shells. Environment: `ORBYN_WORKSPACE_URL`, `ORBYN_UPDATE_MANIFEST`, `ORBYN_CLAUDE_BIN`, `ORBYN_CODEX_BIN`, `ORBYN_CODEX_SANDBOX` (default
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
| `GET /api/workspace` | `WorkspaceStatus` |
| `POST /api/workspace/setup` | Clone or adopt the library (`WorkspaceSetup`) |
| `POST /api/workspace/update` | `{apply}`: fetch and report, or fast-forward |
| `POST /api/workspace/rollback` | Back to the revision before the last update |
| `GET /api/projects`, `POST /api/projects/:id/trust` | Projects and folder trust |
| `POST /api/projects/add` | `AddProject`: register a folder in place; `403 workspace_refused`, `409 project_exists` |
| `POST /api/projects/clone`, `/create` | Make a folder, by default under `repo/`, or at `path`; `create` takes `readme` for a first commit |
| `DELETE /api/projects/:id?delete_files=&confirm=` | `ProjectRemoval`: unregisters; `delete_files` is `400` unless Orbyn made the folder, and can be `409 project_has_work` |
| `GET /api/fs/browse?path=` | `FsListing` for the folder picker; no `path` means home |
| `GET /api/threads?project_id=&archived=`, `POST /api/threads`, `GET, DELETE /api/threads/:id` | Threads; no `project_id` on create makes a scratch folder |
| `POST /api/threads/:id/project` | `MoveThread`, before the first run; no `project_id` means a new scratch folder |
| `POST /api/threads/:id/adopt` | `AdoptScratch`: the scratch folder becomes a project in place |
| `PATCH /api/threads/:id` | `UpdateThread`: rename, pin, archive, settle, snooze, wake, unread, auto-settle |
| `POST /api/threads/order` | Save order; a stale id rejects the whole list |
| `POST /api/threads/:id/title` | Regenerate the title. Spends engine usage, so only on request |
| `GET, PUT /api/settings` | `ServerSettings` |
| `GET /api/updates`, `POST /api/updates/check` | `UpdateStatus`; a check only reads |
| `GET /api/updates/events` | SSE `UpdateStatus` on each change |
| `POST /api/updates/app/apply` | Ask the shell to install (`202`, `409 runs_active`, `422` on a server) |
| `POST /api/updates/apply-all` | `ApplyAllResult`; engines, library, app; stops at the first failure |
| `POST /api/threads/:id/runs` | Admit a run (`202`, `409 thread_busy`, `403 folder_untrusted`) |
| `GET, POST /api/threads/:id/queue` | `QueuedMessage[]`; queue a message, which starts at once if idle |
| `POST /api/threads/:id/queue/resume` | Release a held queue |
| `PATCH, DELETE /api/queue/:id` | Edit or remove a queued message |
| `POST /api/queue/:id/send-now` | Send next, stopping a running turn for it |
| `POST /api/threads/:id/steer` | `SteerRun`: add text to the running turn (`422` if unsupported) |
| `GET, POST /api/threads/:id/attachments?name=` | Raw upload body; `Content-Type` is the kind |
| `DELETE /api/attachments/:id` | Remove an attachment |
| `GET /api/threads/:id/mentions?q=` | `Mentions`: profile skills, ranked unignored files, this project's threads |
| `GET /api/threads/:id/commands?skills=` | `SlashCommand[]`: Orbyn's, the engine's, custom command files, and skills when `true` |
| `GET /api/questions?thread_id=&state=` | `QuestionRequest[]` |
| `POST /api/questions/:id/answer`, `/dismiss` | `AnswerQuestion`; `409 already_decided` carries the existing request |
| `GET /api/threads/:id/items`, `/items/:item` | `ThreadItemRecord`: raw engine items and exit codes |
| `GET /api/threads/:id/usage` | `ThreadUsage`, last reported by the engine |
| `GET /api/threads/:id/files?path=` | `FileEntry[]`, one folder |
| `GET /api/threads/:id/files/ignored` | Ignored paths |
| `GET /api/threads/:id/files/search?q=&content=` | `SearchHit[]` by name or by line |
| `GET, PUT /api/threads/:id/files/content` | `FileContent`; a stale `base_revision` is `409 file_conflict` |
| `POST /api/threads/:id/files/open`, `GET /api/editors` | `OpenInEditor` with optional `line` and `column`; `file_manager` reveals the file |
| `POST /api/threads/:id/git/action` | `GitAction` to `GitActionResult`: commit, push, pull request |
| `GET, POST /api/threads/:id/branches`, `POST .../branches/switch` | List, create and switch |
| `GET /api/forges` | `ForgeStatus[]`; never cached, so it is also the rescan |
| `GET /api/clones`, `POST /api/clones` | `CloneJob[]`; start a background clone (`202`), with an optional `path` |
| `POST /api/clones/:id/cancel`, `/retry` | Stop a running clone; run a failed or cancelled one again |
| `GET, POST /api/threads/:id/pulls`, `POST .../pulls/refresh` | Linked pull requests; refresh also links the branch's own |
| `GET /api/threads/:id/watches`, `POST, DELETE /api/threads/:id/pulls/:number/watch` | `PullWatch`; `400` on a settled, archived or subagent thread |
| `POST /api/watches/check` | One watch pass now (`204`) |
| `GET, DELETE /api/threads/:id/pulls/:number` | `PullRequestDetail`; unlink |
| `POST /api/threads/:id/pulls/:number/review`, `/merge` | Review and merge through the forge CLI |
| `GET /api/pulls?state=&q=&author=&label=` | `PullList` across trusted projects; `failed` names any it could not read |
| `GET /api/projects/:id/pulls?state=&q=&author=&label=` | `PullRequest[]` |
| `POST /api/projects/:id/pulls/close` | `BulkClosePulls` to `PullBulkResult[]` |
| `GET /api/projects/:id/pulls/reviewers`, `/labels` | `PullCandidate[]` |
| `POST /api/projects/:id/workflows/:run/approve` | Let a fork's waiting workflow run; GitHub only |
| `GET, PATCH /api/projects/:id/pulls/:number` | `PullRequestDetail`; `UpdatePull` for title, body, base, draft, maintainer edits |
| `GET .../pulls/:number/checks`, `/timeline`, `/files` | `PullCheck[]`, `PullTimelineEvent[]`, `PullFile[]` with viewed marks |
| `GET, POST .../pulls/:number/comments` | `PullConversation`; `AddPullComment` with optional `path`, `line`, `reply_to` |
| `PATCH .../comments/:comment`, `POST .../comments/:comment/react` | `EditPullComment`; `ReactPullComment` |
| `POST .../pulls/:number/threads/:thread/resolve` | `ResolvePullThread` |
| `POST .../pulls/:number/viewed` | `SetFilesViewed` (`204`) |
| `POST .../pulls/:number/review` | `SubmitReview`, with line comments |
| `POST .../pulls/:number/reviewers`, `/labels` | `SetPullPeople` |
| `POST .../pulls/:number/merge` | `MergePull`: method, `auto`, `delete_branch`, `subject`, `body`, `strip_credits` |
| `POST .../pulls/:number/action` | `PullAction`: close, reopen, revert, update_branch, rebase, delete_branch |
| `GET, POST .../pulls/:number/stack` | `PullStack`; `StackAction` to `PullBulkResult[]` |
| `POST .../pulls/:number/checkout` | `CheckoutPull` to `PullCheckout`, in place or in `<repo>-wt/pr-<n>` |
| `POST .../pulls/:number/work` | `WorkOnPull`: a new thread on that worktree, linked |
| `POST /api/projects/:id/publish` | `PublishProject`: create the remote, with `gh` or `glab`, and push |
| `POST /api/runs/:id/cancel` | Cancel |
| `GET /api/threads/:id/events` | SSE `ThreadEvent`, resumes from `Last-Event-ID` |
| `GET /api/approvals?state=pending`, `POST /api/approvals/:id/decide` | Approvals |
| `GET /api/threads/:id/diff?scope=` | `FileDiff[]`: `worktree`, `turn&run=`, `thread`, `branch&base=`, `commit&sha=` |
| `GET /api/threads/:id/commits` | `CommitInfo[]`, newest 100 |
| `GET /api/threads/:id/checkpoints` | `Checkpoint[]` |
| `POST /api/threads/:id/restore` | `RestoreWorkspace`; `409 shared_directory`, `409 thread_busy` |
| `POST /api/threads/:id/rewind` | `RewindThread`: continue from before a run |
| `POST /api/threads/:id/fork` | `ForkThread`: a child thread with the log up to a run |
| `POST /api/threads/:id/switch-engine` | `SwitchEngine`: hand the conversation to another engine |
| `GET /ws/terminal/:thread_id` | Main PTY: binary in/out, JSON text frame `{cols,rows}` resizes |
| `GET /ws/terminal/:thread_id/:terminal?observe=` | Attach to a named terminal; `observe` is read-only |
| `GET, POST /api/threads/:id/terminals` | `TerminalInfo[]`; `OpenTerminal` with `split_of` and `direction` |
| `PATCH, DELETE /api/threads/:id/terminals/:terminal` | Rename, close |
| `GET, DELETE /api/threads/:id/terminals/:terminal/scrollback` | `TerminalScrollback`; clear |
| `GET, POST /api/threads/:id/scripts` | `ProjectFileView`; `RunScript` to `TerminalInfo` |
| `GET /api/engines`, `POST /api/engines/refresh` | `EngineStatus[]` |
| `POST /api/engines/:id/update` | Run the owning installer (`409 engine_busy`) |
| `POST, DELETE /api/engines/custom[/:id]` | ACP, AG-UI and terminal engines |
| `GET /api/skills`, `POST /api/skills/rebuild` | Library skills; rebuild only re-reads them |
| `GET, POST /api/skills/profiles`, `DELETE /api/skills/profiles/:id` | Profiles |
| `GET /api/usage?days=` | `UsageReport` from local history, rescanned on each read |
| `POST /api/usage/refresh?days=` | Forgets scans and limits, then reports |
| `GET /api/limits?force=` | `LimitsOverview`: pooled windows, each engine, and what could not be read |
| `GET /api/engines/:id/limits?force=`, `GET /api/threads/:id/limits?force=` | `EngineLimits`; `422 unsupported` if the engine reports none |
| `GET /api/engines/:id/models?refresh=` | `EngineModels`, with effort options per model |
| `GET, POST /api/policy/rules`, `DELETE /api/policy/rules/:id` | Internal: diagnostics only, no client uses these |
| `GET /api/audit?thread_id=&limit=` | Internal: diagnostics only, no client uses this |
| `GET /api/computer`, `POST /api/threads/:id/computer` | Status, and a governed action |
| `POST /auth/session` | Exchange a remote access key for a cookie (`204`) |
| `POST /agui/threads/:id` | External AG-UI endpoint (`RunAgentInput` in, SSE out) |
| `POST /mcp/:thread_token` | Per-run MCP server |
