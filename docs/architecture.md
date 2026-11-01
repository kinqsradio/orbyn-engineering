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
| Desktop shell | `desktop/src-tauri` | Spawns `orbynd`, loads its loopback URL, tray, app updates and what only the OS can do |

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
- A stop is saved before anything is signalled, so a run stopped by a person ends
  `cancelled` even if the process dies first. Recovery closes tools the dead process
  left open with a note. A run still `admitted` never reached an engine, so its message
  returns to the front of the held queue, without attachments, and is not resent on its
  own. A later state may have reached the engine and is never resent.
- A forced stop (`POST /api/threads/:id/force-stop`) is for an engine that stopped
  answering, so it skips the wait for it: the stop is saved, the process tree and those
  of delegated threads are killed, and the run ends `cancelled` within seconds. If a stage
  around the engine is what hangs, the run is closed anyway after four seconds, and
  fencing keeps out whatever it does later. With nothing running it changes nothing.
- Terminal states never change. Every transition is a compare-and-set on the
  previous state, so a late engine event cannot revive a finished run.
- A run owner is fenced by `(run_id, owner_epoch)`. `owner_epoch` is a value
  chosen at process start; a stale owner's writes are rejected.
- A file lock gives each data directory one live `orbynd`, because a second
  process's recovery would fence runs that are still alive. The lock file names its
  owner: a live one refuses at once, and a dead one's lock gets a few seconds to clear,
  since a child caught mid-exec can hold it briefly after a crash.
- Pending approvals expire in the same transaction that ends a run.

## Thread lifecycle

Settling removes a pin and ends a snooze; it needs no active run and closes the
thread's terminals. Un-settling returns a thread to the top and holds off automatic
settling until new activity. Archiving hides a thread and refuses new runs. Your
message, an approval request and a run ending all wake a snoozed thread; those
wakes share the transaction that caused them. Any wake but your own message or a
manual one leaves `woke_at` until dismissed. Thread activity never changes the
saved order. A running thread or descendant is never settled automatically or
deleted. Lifecycle changes are logged as `CUSTOM thread.updated`.

A run a dead process left mid-work continues on the first lifecycle pass after a restart,
with a continuation message, unless `continue_threads_after_update` is off. Each thread
gets three of those in a row; your own message resets the count. `visited_at` is the last
time you were reading a thread, and a thread with a watch counts as working.

A side chat is a fork with relation `side`: it may start while its parent runs, stays
out of the thread list, works in the parent's folder and starts `supervised`. Bring back
adds its own messages to the parent's handoff and leaves the parent's engine session
alone, so the next run carries them once. It needs an idle parent.

A run that fails on a usage or rate limit leaves a limit on its thread: the engine's
words, when it stopped and the reset if the engine gave one. Any new run, settle or
archive clears it. With a reset in the future, `auto_resume_limited_threads` schedules a
continuation and `snooze_limited_threads` snoozes until then; each can also be chosen on
the thread. Due continuations start from the lifecycle pass, so an overdue one starts on
the first pass after a restart, and a held queue stays held until that run ends.

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

`response_streaming_mode` `turn` holds a reply's text until that message ends;
`paragraph` is the default and writes it as it comes, merged over 33 ms. Reasoning and
tools always go out as they happen. Steering answers `delivered` or `queued`: an engine
with no mid-turn input takes it on the next turn, and an engine that refuses one sends it
to the queue with a `steer.failed` note. A typed decline carries its words only on
engines with `decline_feedback`, which today is Claude; elsewhere the message queues.

Attachments stay in app data, never in a target, and are removed with their thread.
The limits are 100 per thread, 10 MiB per image, 80 MiB of images and 50 MiB per other
file. A record exists only once its bytes are in place, and a message naming an
attachment that is not ready is refused before anything is admitted.

## Models

`GET /api/engines/:id/models` comes from the engine itself. Claude answers the
`initialize` control request of a print-mode process that never gets a prompt, which
works logged out and spends no usage. That process runs in an empty temp folder with
`--strict-mcp-config`, an empty `--mcp-config`, `disableAllHooks` through `--settings`
and `--no-session-persistence`. The flags matter as much as the folder: on 2.1.150 a
user-level `SessionStart` hook and MCP server both fired from an empty folder without
them, and neither did with them. The reply's account block is never stored, logged or
returned. Commands and agents from it feed the `/` list, and output styles are listed
but not set. If the CLI cannot say, its documented aliases stand in with `fallback`
set and `error` saying why, and a stand-in list refuses nothing.

Codex reads `model/list`, every page, hidden models left out, on a short-lived
app-server, then `config/read` with no folder for a configured `service_tier`, which
becomes the default wherever a model offers it (config's `fast` is a catalog's
`priority`). An ACP agent's models, modes and config options come from a session opened
in a temp folder with no prompt sent. Some list what a model offers only once it is
chosen, so a probe chooses up to 24 in turn, within 15 seconds, and keeps what differs from
the session's own options. It then deletes that session where the agent offers
`session/delete`, or closes it with `session/close`, so it never shows among real work.

Claude's list is kept until its CLI version or login changes, which is compared at most
once a minute. Other lists are kept five minutes, a stand-in 30 seconds, and `?refresh=
true` always asks. A failure, a stand-in or an answer with no models never replaces a good list: the last
one stays, with `error` saying why, and a read of Claude stops at 4 MiB. With no list
yet, a failure is reported with the list empty rather than as an error.

A selection is a model, an effort and `options` by `ModelOption` id: `service_tier`
(`default` is Standard), `fast_mode` (`on`, `off`), `mode` and `config:<id>` for ACP.
It belongs to the thread, is set by `PATCH`, by a turn, or by a queued message when that
message starts, and an empty string goes back to the engine's default. A steer leaves
the running turn alone and applies from the next. A fork keeps the selection. An engine
switch takes what was asked for, then what was last chosen on that engine, and never
keeps the old engine's values. The last selection used on an engine is remembered and
reported as `remembered`. A new thread takes the request's model, then the project's
`default_model` (when `default_engine` is empty or matches), then the remembered one,
and effort and options carry only along with their model. A project's
`default_permission_mode` also applies there.

Admission refuses a value the model does not offer with `422 unsupported_option`, and
stores nothing. A model the engine did not list may be custom, so only engine-wide
options are checked for it. `PATCH` does not check, because a model and its effort
change in two steps. A run's start checks again, which is what catches a queued message
that outlived a model; that run fails with the same message.

`fallback_model` covers a model that went away. When the engine's own list, not a stand-in,
no longer has the thread's model, the model is not a custom one and the list has the
fallback, that turn runs on it with no effort or options and logs `engine.warning`. The
thread keeps its choice, so the model is used again when it returns.

`effort` reaches Claude as `--effort`, an ACP config option is applied once acknowledged
in the order mode, model, options before the prompt, and a mode or option the session
no longer lists fails the turn. Fast mode reaches Claude as `fastMode` through
`--settings`, the settings key its schema names, only on a model reporting
`supportsFastMode`. A logged-out 2.1.150 lists it for `default` once the child
environment is clean, but no live turn has run with it.
Codex keeps a turn's values for later turns, so every `turn/start` states model, effort
and tier, filled from the catalog when unset, and Standard is a `null` tier. A new model
on a Codex thread goes through `thread/resume` and `turn/start`, keeping the same
thread. Each run logs what it went out with as `CUSTOM engine.selection`. A real
0.166.0 turn through `orbynd` wrote the chosen model and effort and a null tier to its
session record.

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

## Engine failures

Failure text is cleaned before anyone sees it: terminal codes go, and a line that looks
like a credential, by key name, vendor prefix or shape, is dropped whole. A run that
failed for want of a login says so and names the vendor's command, such as `claude auth
login`, and logs `CUSTOM engine.sign_in_required`. Orbyn only names the command, under
rule 1. Status commands are bounded by time and to 256 KiB, and `claude auth status` is
read for its logged-in flag alone.

Mode is stated on every launch: Claude's `--permission-mode`, and Codex's approval policy
and sandbox on `thread/start`, `thread/resume` and `turn/start`, because a saved session
otherwise keeps the policy it last had.

Parsers are tested against recorded real frames in `driver/fixtures`, named by version.
`cargo test -p orbyn-core live_ -- --ignored` reads each installed CLI's real catalog,
with no prompt.

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
for the next run. Dropping the session and writing the handoff share a transaction. It
stays until a run that carried it completes, so a failed start, a stop or a restart
leaves it pending, and until then `/compact` and `/goal`, which reach an engine bare, are
`422 unsupported`. The log stays whole; a rewind is logged as `CUSTOM
thread.rewound` for clients to hide what follows. Native rollback (`thread/revert`)
is not used.

## What a run changed

A run's change list holds only files a tool named, never what status shows, so a thread
sharing the folder adds nothing. Both ends of each file are kept as bytes in the
database. The new ones are read when the tool ends, which freezes them against anything
later. The old ones come from the moment the gate allows the write, or failing that the
run's start checkpoint. An engine's "started" notice is not used, because it can arrive
after a fast write and make a change look like none. A write nothing reports, such as a
shell script, can be declared with `orbyn_track_files`. With no source, as in a full-access
Codex turn outside Git, that end is `unknown`, which is reported rather than guessed. Links, `.git` and anything outside the
checkout are never read. The limits are 200 files and 32 MiB a run and 1 MiB a file, and
past 512 MiB in all the oldest bytes go while their paths stay.

Reading a change uses only what was kept. A restore puts files back to either end from
those bytes, so it works on one file, outside Git and in a folder other threads share,
where a checkpoint cannot. It needs the thread idle, and a file holding anything but the
run's own two versions is reported as `conflict` and left alone. An added file is removed
by a restore to the start.

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

A terminal on Windows opens a native `pwsh`, then `powershell`, then `ComSpec`. `SHELL`
is ignored there. A thread holds up to 32 terminals, each with 5,000 lines and 8 MiB of scrollback kept
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

## Settings and maintenance

`ServerSettings` holds lifecycle and pricing. Everything else is in a fixed catalog of
preferences, each with a default and a shape: an unknown key or a wrong shape is
`400`, and a change applies all of its values or none. A preference resolves project,
then global, then default, and only those marked `project_scoped` can be set per
project. The catalog holds no secret: provider environments and tokens stay out under
rule 1. `disabled_engines` is enforced when a thread is created, and custom, hidden
and reordered models apply in `/api/engines/:id/models`.

`provider_instances` holds named setups of an engine, each its own engine to threads,
with its own models and sessions, so changing a thread's instance is an engine switch. An
instance has an id, a `driver`, and optionally a name, an accent, `enabled` and a `program`
that replaces the driver's. ACP, AG-UI and terminal instances also take `args`, added after
the driver's. Claude and Codex take a program only, because a flag can switch off the gate.
A turned-off instance is not listed and refuses new runs, and threads keep their history.
An instance of Claude is still Claude to the permission prompt, rules, version checks and
custom commands. Nothing here holds an account: no environment, no config folder, so a
second login stays out under rule 1. The list is global, so no tool can reach it.
Changing the list clears model catalogs and selection validation, so a changed setup
cannot keep the former driver's offered options. Since instances can share a binary,
an engine update refuses while any run is active, and no run starts during an update.

A new worktree uses `branch_name_prefix`, `base_branch` or the origin's head when
`new_worktrees_start_from_origin` is on, falling back to HEAD, and
`worktree_submodules`, where the project file's choice wins. `auto_pull` fast-forwards
a clean checkout on the remote's default branch every 30 minutes.

`keybindings.json` lives in app data and holds only the person's changes over built-in
defaults, so new defaults reach them. It allows comments and trailing commas, and a
bad entry is reported while the rest apply. A key with two commands in one exact
context is a conflict; a key in two contexts is not.

Storage cleanup removes logs, browser artifacts and worktrees settled past their
retention. A worktree goes only through `git worktree remove` with no force, so Git
keeps uncommitted work, and never while another active thread uses it. `?dry_run=true`
only reports. Database repair is a `VACUUM`, refused during a run, and suggested at
1 GiB reclaimable. The OTLP check posts an empty export and reports the status.

## Message search

A message is split over many events, so `thread_messages` keeps each one whole, written
in the same transaction as its event, copied with a fork and filled from the log for
threads made before it. Reasoning is not in it, and a rewind takes out what it hides from
clients while the log stays whole.

A message matches when it holds every word, in any order, ignoring case. A search needs
one word of at least three characters, or two in Chinese, Japanese or Korean, which has
no spaces and packs more into a character. Shorter words still have to match; a query
with none long enough returns `too_short` and reads nothing. At most 16 words and 200
characters, 200 hits and the newest 50,000 messages are read, and `truncated` says when
that left something out. Archived threads are searched only when asked.

## Automatic requests

`GET /api/network` and `crates/orbyn-core/src/network.rs` list every outbound request
Orbyn makes without being asked, with host, cadence, what turns it off, the key that does
and whether it is on now. A new one is added there in the same change, with a switch.
The two-minute pull request poll has its own, `poll_pull_requests`. Engines make their own requests under their own terms.

A thread's first message also spends one short engine call on its title, in the
background, unless `auto_thread_titles` is off. It sees only that message and goes through
the thread's own engine with no tools and no session. The model is
`text_generation_model` when that engine lists it, otherwise the engine's small model,
otherwise the thread's. A thread with a chosen title, a delegated thread, and a goal
command are left alone. A failure keeps the default title, and a rename that lands first
wins.

## Automations

A scheduled task fires on an interval, at a fixed time on chosen weekdays in a fixed
UTC offset, on a webhook, or after a run of another thread in its project ends,
optionally only when it completed. The clock is checked each minute, so a follow-up starts
within one, and answers each run once, never one from before the task existed. A task
cannot run on the thread it follows, which would set itself off for ever. Each firing queues the
prompt on the task's thread, or on a new thread, in that project's normal permission
mode, and needs a trusted project at that moment. A failed firing records why and
tries again at the next time. Changing a task by id replaces what it does and keeps
what it earned: its history, pause, token and, unless replaced, signing secret. It
stays in its project, and its thread must be in that project too.

`POST /hooks/:id/:token` is public, because a sender cannot hold a session, though the
`Host` and `Origin` checks still apply. The token is shown once and kept as a digest,
and a wrong token is the same `404` as an unknown task and is not logged. Past the
token, a request is checked for its HMAC-SHA256 signature, age, up to 16 filters and
dedupe key, in that order, and each result is logged with credentials removed. The
reply is `202` if accepted and `200` with the status otherwise. Only an accepted key
counts for dedupe. A webhook is untrusted input aimed at an agent: `{{body.a.b}}` and
`{{headers.x}}` values reach the prompt inside a random per-request tag, with mentions,
skill sigils, slash commands and tags broken, and the prompt says the text is data. The
signing secret has to stay readable to check an HMAC, so it is stored in the database
and never returned. It is a webhook's own secret, not an engine or forge credential.
Reaching a machine from outside is up to the person; Orbyn runs no relay.

A delegated thread is a `subagent` child in the parent's folder. When it ends with
nothing queued, it reports through the parent's queue, with the newest text within
the handoff budget, which wakes the parent. Cancelling a run cancels the runs of its
delegated threads. A delegated run with no event for eight minutes, twice the longest a tool
may take, is ended as failed and says so. Waiting on a person does not count, and a run
someone is watching is never ended for going quiet.

## Files

File routes need a trusted folder and share the engines' write scope, so `..` and
symlinks cannot leave the checkout, and `.git` is out of reach. A save names the
revision it started from; a file that moved on is reported, never overwritten, and
new bytes arrive by rename. A read opens the resolved file without following a link and
checks the path again, which narrows the window for a swapped folder but cannot close it
on every filesystem. A path is judged where it lands, so a link into `.git` or a
different spelling of it on a case-insensitive disk is refused too. These saves are the
user's own edits, audited, and differ from rule 4, which covers what Orbyn adds on its
own.

`GET .../files/raw` serves bytes from that same checked handle, up to 1 GiB, with one
byte range at a time; a form it does not serve gets the whole file. A checkout holds
code nobody here wrote, so nothing in it may run in this origin. The type comes from
the name, never the bytes: images, audio, video, fonts and PDF are `inline` and
everything else is `application/octet-stream` as an attachment. All of it is `nosniff`
and sandboxed by CSP, which is what makes SVG safe, except PDF, which browsers will not
show sandboxed. An image or video element cannot set a header, so this route takes
`?token=` as the streams do, with `no-referrer` to keep it out of anything a file links
to.

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
are woken after commit. Text from an engine is merged for up to 33 ms or 8 KiB before it
is written, and anything else flushes it first, so order holds. Tool traffic is bounded
per tool: arguments at 16 KiB, output at 8 KiB with a notice, and after 64 tools a run
keeps a tool's row and not its output. Raw items stay whole for the inspector. A follower carries only a position and always reads from
the log, so replay and live are one loop. `GET /api/threads/:id/events` is SSE: it
replays from `Last-Event-ID`, then follows live. Events use AG-UI 1.0 names.
Delivery to clients is a projection of the log; a client that reconnects loses
nothing.

A plan has two forms. Steps are a `plan` activity, from Codex's `turn/plan/updated` and
Claude's `TodoWrite`. A proposed plan is an assistant message holding
`<proposed_plan>...</proposed_plan>`, from Codex's finished `plan` item and Claude's
`ExitPlanMode`, so it also reaches a handoff and search. A subagent's stay out.

Activity types are `approval` (content is the `Approval`), `plan`
(`{steps: [{title, status}]}`), `diff` (`{files: [{path, additions, deletions}]}`)
and `unmanaged`. `question` (content is the `QuestionRequest`), and `CUSTOM` carries `tool.output`,
`tool.finished`, `subagent.activity`, `usage`, `goal.updated`, `engine.warning`,
`engine.retrying`, `engine.selection`, `engine.sign_in_required`,
`engine.session_lost` and `run.force_stopped`. The prompt is logged as a `user` text message whose id ends in
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

`engines/known.rs` lists CLIs that speak ACP from their own binary, with what each needs
to start: Antigravity, Cline, Command Code, GitHub Copilot, Cursor, DeepSeek, Devin, Grok
Build, Hermes, Kilo, Kimi and OpenCode. One is listed only when its program is found, and
a custom engine of the same id wins. Grok is started with `--permission-mode default` and
OpenCode with `{"permission":{"*":"ask"}}`, since either can otherwise act without asking.
DeepSeek cannot ask before an edit, so it is labelled unmanaged under rule 8. Each keeps its
own login, and only the launch has been tested, with the fake agent under those names.

Skills come from the workspace, in place. Nothing is copied, packed or signed.

- Claude starts at the workspace root and discovers `.claude/skills` and the
  library's `AGENTS.md` natively. It has no `--plugin-dir`, and gets a per-run
  `--mcp-config`, `--permission-prompt-tool mcp__orbyn_engineering__approve` and
  `--add-dir <checkout>`. Its working directory is the library, so a relative path
  means the library, and the bootstrap tells it to use absolute paths and run
  commands from the checkout.
- Codex's process and `thread/start` use the workspace root, and each `turn/start`
  sets `cwd` and `sandboxPolicy.writableRoots` to the selected checkout. The turn's
  `cwd` must stay the checkout: a real 0.166.0 turn against a local stub provider, with
  no model involved, wrote to the checkout and was denied the library, but with the
  library as its `cwd` it wrote to the library and relative paths landed there.
  `command/exec` is not the same: it also let the app-server's own cwd be written, and
  engines do not use it. The same stub showed what a first turn sends: the environment
  context, workspace root, permissions and `AGENTS.md` all come from the turn's `cwd`, so
  nothing the model sees names the library, and neither its `AGENTS.md` nor its
  `.agents/skills` reach it. Codex therefore takes skills from the MCP tools. The thread
  stays at the library because moving it changes nothing the model sees and would load
  the target's `.codex` config as the session's own. It has a per-thread
  `mcp_servers.orbyn_engineering` config and app-server approval requests.
- Non-native engines start in the checkout and reach skills through the MCP server,
  or through the skill list in the bootstrap. That list is only there for an engine
  with neither: native discovery and the tools already know the selection, and a long
  list in front of a first turn crowds out the request. The bootstrap leads with what
  the engine can do, since a first turn that read mostly limits once answered that it
  had no access to the checkout, with no tool call, though nothing stopped it.

## Workspace

The skills library is the product's built-in harness, so nobody sets it up. There is
one managed workspace at `<data>/workspace`, or an existing checkout the user adopts in
place, which is never moved. Startup puts the library there before the service answers
anything, so no route waits on it and a run never does.

The app ships a snapshot: `build/library/library.tar`, a `git archive` of the revision in
`scripts/library.lock`, MIT, with its `LICENSE` inside and beside it, passed as
`--library-bundle`. First launch unpacks it, needing no network and no Git, into a staging
folder, makes one local commit so that it is a Git root like any other library, and
renames the folder into place, so `<data>/workspace` is whole or absent. A link becomes the
text file Git would leave where the OS refuses one, and status then reports the MCP route.
An entry or link leading out refuses the bundle. With no bundle, as with a bare `orbynd`,
the library starts empty and the clone brings the skills. With no Git it stays a plain
folder, and reports the bundled revision.

In the background, about five seconds after startup and then with gaps doubling up to six
hours, a clone of the URL (`--workspace-url`, `ORBYN_WORKSPACE_URL`) with
`core.symlinks=true` is made in a staging folder and checked. Failures are quiet and keep
the snapshot. Finished, it waits for a moment with no run, then swaps by rename under the
admission lock, so a run arriving then waits for those few renames: the old library moves
aside, the clone moves in, `repo/` moves across and the old folder goes.
Library status and update readers hold an async read guard until their Git children
finish. The final swap takes the matching write guard before checking for local edits
and taking the admission lock, and releases it before waiting for active runs.
The shared Git command runner owns a process group or Windows job, so cancellation stops
its descendants; once the leader exits, remaining descendants are stopped before output
collection ends.
Service shutdown joins the library-upgrade task and settles cancelled update checks before
shutting down the core. Package smoke requests shutdown by parent-stdin EOF, awaits exit
and treats a profile that cannot be removed as a failure.
A library with local edits, or anything ignored beside `repo/`, is left as it is and
shown as dirty.
Startup finishes or undoes a swap a crash interrupted, by what it finds: an old folder with
no library goes back, one with a library hands over its `repo/`. Other staging folders are
removed, and anything unusable found at `<data>/workspace` with no record of it is set
aside as `.workspace-broken-<id>`, not deleted. This runs under
`background_update_checks`, and `ORBYN_OFFLINE` stops it. Asking the update center to check
tries at once, whatever the setting. Updates work only once it is a clone, through the
update center as below.

Adopting is an optional setting. `POST /api/workspace/setup` with `adopt_path` switches to
an existing library at any time no run is active, and data folders that adopted one or
cloned one before all this keep it. `url`, or an empty body, asks for the clone now and
reports why it failed. The app opens on the draft flow, shows one calm line in the rare
case `configured` is false, and keeps library choices in Settings.

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
success. Engines and the library never apply on their own. The app does only with the
`app_update_mode` preference at `automatic` (the default is `notify`), no active run, an
install the shell can make and no request that changes anything for two minutes. An
engine update counts only when the version read back afterwards has changed, since an
installer's exit code says only that it finished.

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

## Desktop shell

The UI holds no native access. `desktop/src-tauri/build.rs` lists the shell's commands,
so a capability decides who may call them, and the only capability is the local loader
page's. The product UI, served by `orbynd`, has none. It asks the service, the service
asks the shell over the same stdin and stdout as app updates, and what the shell sees
goes back the same way to `GET /api/shell/events`. `ShellBridge` in core owns this side.
Events wait, eight at most, for the first window to connect, and `GET /api/shell` counts
the windows following them, which is how a startup check knows the UI ran. A line that
isn't the bridge's goes on to `UpdateCenter`.

The window stays on the loader and the running service. Anything else is refused, and
`http`, `https` and `mailto` go to the system browser instead. No other scheme is
handed over, so a page cannot start whatever program claims one.

`orbyn://` links come from outside the app, so they only move a window, and only to a
place spelled as a route: `thread/<id>`, `new[/<project>]`, `settings[/<section>]`,
`usage`, `pulls`, or nothing for home. The service turns one into a route and drops
anything else, and a link that started the app waits in the shell until the service
runs. A second launch hands its links to the first and exits.

`POST /api/shell/actions` takes one of a closed list of `ShellAction`s and carries no
path, URL or command. It answers `422` with no shell. The menu bar handles what acts on
the window, and everything else goes to the windows as a `command`, the same ones keys
run. No item claims `Cmd+W` or `Cmd+N`: those are the page's, by its own rules. The zoom
is kept beside the window state in the app's config folder.

The service owns the rule for running work and sends `activity` when it changes: the
counts and whether to stay awake, which is any run unless `keep_awake_during_runs` is off.
The shell applies it. The Dock badge counts only runs waiting on a person, the tray shows
the rest, and idle sleep is held off, by `caffeinate -i -w` on macOS and
`SetThreadExecutionState` on Windows. The display can still sleep and a closed lid still
sleeps.

The shell reports `shell_facts` at start and whenever its window takes focus, since a
permission changes in System Settings: the `orbyn` command's path and whether it is there,
and on macOS Accessibility and Screen Recording, read without prompting. Install puts a
link in `~/.local/bin` on macOS and a `.cmd` under `%LOCALAPPDATA%\Orbyn\bin` on Windows,
never touches `PATH`, and neither replaces nor removes a file the app didn't put there.

The service's stderr goes to `orbynd.log` in the app's log folder, new each launch. It is a
file and not a pipe so the service can still log its own shutdown after the shell dies: a
write to a dead pipe stops it before it cleans up. When the service stops, the loader
shows the log's last line with Try again, and threads and runs are kept.

The desktop job installs the built package and starts it with a private profile and no
secrets: `scripts/smoke-app.mjs` waits for the UI to connect from the window, checks a
second launch hands over, and sees the service end with the app. `scripts/smoke-package.mjs`
only proves the service runs. The release job adds notarization checks, a SHA-256 per
asset and a CycloneDX inventory from the lockfiles, which fails when a source is empty.
Windows binaries link the C runtime statically, and the installer is per-user with the
WebView2 bootstrapper embedded and silent. The release workflow publishes nothing: it
leaves a bundle for a person to promote.

The shell passes no data folder, so `orbynd` and the `orbyn` command agree on it, and it
sets no `PATH`: `child_env` widens that for every child without sourcing a shell.

## Per-thread MCP server

`orbynd` serves MCP over streamable HTTP at `/mcp/:thread_token`. The token is
random per run, is passed only to that run's engine, and is revoked at run end.
Tools: `approve` (Claude permission prompt), `skill_search`, `skill_load`, the
governed `computer_*` tools and `orbyn_*` tools for threads, projects, worktrees,
attachments, preview tabs, pull requests, delegation, scheduling and declaring writes.
`approve` is listed only for Claude.

An `orbyn_*` tool reaches only the caller's project, its thread's preview tabs and, for
an attachment, its own checkout; anything else reads as not found. A preference a tool
sets is the project's, never a global one. A project cannot be created, cloned or
removed from a tool, since those reach past it.
Claude's permission prompt passes Orbyn's own tools without asking, so each tool with
an effect goes through the gate itself as a `tool` action, which needs a person unless
the thread is in full access or a rule allows it. Every call is audited first. A
delegated thread cannot delegate further, so one run cannot fan out without limit.

## Computer gateway

The order is fixed: resolve the target, evaluate policy, write audit, act. Browser
page actions resolve to the current page URL, so rules match where the action
lands. An action with no active run cannot wait for a person, so `ask` refuses and
only an explicit allow rule passes.

## Preview

A preview tab is a headless Chrome with its own profile, apart from the governed
browser agents use, and needs a trusted folder and an `http` or `https` URL. Up to
four run at once, and they close when their thread settles, archives or is deleted.
Frames are polled about five times a second, only while someone watches or records,
and a frame that did not change is not sent. `/ws/preview` sends each as base64 JPEG
text. Watching gives no control: input needs a person to take the page first.
Recording keeps the changed frames as numbered JPEG files in
`<data>/browser-artifacts`, with no video encoder. Agents do not act on a preview tab
yet, so taking control only guards against a watcher's stray input.

A tab's zoom, appearance and phone layout are set with `/view`. Zoom keeps the frame the
same size and lays the page out smaller, 0.25 to 3 times. New tabs start from the
`preview_zoom` and `preview_appearance` settings. A tab with no named profile ends with its
profile. A named profile lives in `<data>/browser-profiles`, survives restarts, and holds
one tab at a time because a browser locks its profile folder. A private tab only stays
out of the UI's history. `/previews/file` opens a file inside the checkout as `file:`,
which agents and the address bar cannot reach. Picking an element reads it and changes
nothing, and what it returns comes from the page, so the UI quotes it into the draft for a
person to read before sending. A browser that dies is started again on the same profile and
page, up to three times in 30 seconds after 1, 2 and 4 seconds, and then the tab reports
`crashed`. This only runs while someone watches. `enable_agent_browser_access`, off
globally or for a project, refuses every `orbyn_preview_*` tool.

Back and forward step through web pages only, so the blank page a browser starts on
and anything else not `http` or `https` is passed over, and at either end nothing
happens. A link clicked in the page changes where a tab is with nobody telling this
side, so the address and those two flags are reread about once a second while someone
watches. A page is 100 to 4096 pixels each way, which also bounds each frame.

The headless shell's separate GPU process exits once a page composites, which ends the
browser, so a binary named as that shell gets `--in-process-gpu` on macOS and Linux.
`ORBYN_BROWSER_IN_PROCESS_GPU` forces it for one behind a wrapper.

`/api/threads/:id/servers` lists TCP listeners whose process runs from the checkout.
`lsof` finds them on macOS, and on Windows a PowerShell query with `netstat` behind it
finds loopback and wildcard listeners. Each process's folder is read from the OS, so
both platforms apply one rule: a server in the checkout can be stopped, one in another
folder isn't listed, and one whose folder can't be read, like a system service, shows
with `in_checkout: false` and can't be stopped. Stopping on Windows ends the process and
its children by force, since a server has no window to ask.

## Tool budgets

A tool call answers within 45 seconds, under the minute engines allow, and one that
can wait on a person gets 240. Going over drops the call, and a dropped wait expires its
approval, so a late answer does nothing. Claude's `approve` is a run's permission prompt
and stays on `ORBYN_APPROVAL_TIMEOUT_SECS`. `orbyn_thread_wait` waits at most 40 seconds
and reports `ended: false`. A request can be 512 KiB and a reply is cut at 256 KiB.

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

## Child environment

Everything Orbyn spawns goes through `child_env`. Started inside a Claude Code session,
`CLAUDECODE` and the rest of that host's `CLAUDE*` variables are removed, which matters
because some put a child into a reduced mode. `CLAUDE_CONFIG_DIR`, the provider switches
and `CLAUDE_CODE_OAUTH_TOKEN` are a person's own settings and stay. `CODEX_SANDBOX`-style
session markers go always, and an AppImage's variables and its mount's entries in
library, data and `PATH` lists go when `APPIMAGE` and `APPDIR` are both set. The
`prefer_saved_login` preference also drops API keys and endpoint overrides from engines
only, so they use their own login. `EngineStatus` reports inherited credentials by
variable name and an endpoint by origin, never a value. No value is read for any other
purpose, which keeps this inside rule 1.

`PATH` for lookups and for children is the inherited one, then usual install folders
that exist: Homebrew, `~/.local/bin`, cargo, bun, Volta, asdf, mise, pnpm, fnm's default,
the newest nvm or `n` Node, and the npm prefix from `NPM_CONFIG_PREFIX` or `~/.npmrc`.
Nothing runs a shell or npm to learn these. On Windows a `.cmd` is followed to the script
it wraps, including pnpm's store and a same-named sibling, a `node.exe` beside the shim
wins, and a shim that points at a shell is refused.

## ACP registry

`GET /api/acp/registry` reads the public registry on request, and installing an agent
makes it a custom engine named `acp-<id>`, with no account and no credential: one that
needs a login says so when run, under its own command. The registry is someone else's
file, so an entry that does not parse is left out, and ids and versions that reach a
path must be plain. `npx` and `uvx` agents install nothing here. A package name cannot
read as a flag, and those tools fetch it on first run. A binary is taken only over `https`,
with the digest the entry gives, and one with no digest is not installable. It is
unpacked into a staging folder under `<data>/acp-agents`, a link leading out or a command
outside the folder refuses it, and only then does it become the install. Removing one
takes its files and engine, refused during a run, and threads keep their history.

## Command line

`orbyn` is a client of a running service, with no rule of its own: `thread`, `project`,
`theme`, `status` and `doctor` go through the API the UI uses, and `serve` runs `orbynd`
from beside it. It finds the service in `service.json` in the data folder (`--data-dir`,
`ORBYN_DATA_DIR`), holding the URL, the launch token and the process id. That file is
private like any secret file and goes when the service stops; one left by a crash reads
as nothing running. Exit codes are 0, 1 when a request was refused or a waited-on run
did not complete, and 2 when no service is running. `--json` prints the API's answer.

## Service configuration

`orbynd serve` takes `--port`, `--data-dir`, `--ui-dir`, `--library-bundle`,
`--workspace-url`, `--update-manifest`, `--remote`,
`--tls-terminated`, `--allowed-host` and `--parent-stdin`, and prints one JSON line
`{url, token}` on stdout once it can serve. `--skills-dir` is accepted and ignored
for older shells. Environment: `ORBYN_DATA_DIR`, `ORBYN_ACP_REGISTRY_URL`, `ORBYN_LIBRARY_BUNDLE`, `ORBYN_WORKSPACE_URL`, `ORBYN_UPDATE_MANIFEST`, `ORBYN_CLAUDE_BIN`, `ORBYN_CODEX_BIN`, `ORBYN_CODEX_SANDBOX` (default
`workspace-write`), `ORBYN_APPROVAL_TIMEOUT_SECS` (default 1800),
`ORBYN_AGENT_DESKTOP`, `ORBYN_BROWSER`, `ORBYN_BROWSER_HEADLESS`,
`ORBYN_BROWSER_IN_PROCESS_GPU`, `ORBYN_OFFLINE`
(skip latest-version lookups) and `ORBYN_LOG`.

## HTTP API

All bodies are JSON and errors are `ApiError` with a stable `code`. Auth is
`Authorization: Bearer <token>`, or the session cookie. SSE, WebSocket and
`files/raw` also accept `?token=` because browsers cannot set headers on them.

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | `ServerInfo` |
| `GET /api/workspace` | `WorkspaceStatus` |
| `POST /api/workspace/setup` | Optional. `WorkspaceSetup`: adopt a library, or ask for the clone now; `409 runs_active`, `409 library_dirty` |
| `POST /api/workspace/update` | `{apply}`: fetch and report, or fast-forward |
| `POST /api/workspace/rollback` | Back to the revision before the last update |
| `GET /api/projects/:id/pulls/:number/revisions`, `GET /api/projects/:id/commits/:sha/files` | A pull request's commits, oldest first, and what one commit changed |
| `GET /api/diagnostics`, `POST /api/diagnostics/processes/:pid/stop` | `Diagnostics`, in memory only; a stop reaches only this service's own descendants |
| `GET /api/projects`, `POST /api/projects/:id/trust` | Projects and folder trust |
| `POST /api/projects/add` | `AddProject`: register a folder in place; `403 workspace_refused`, `409 project_exists` |
| `POST /api/projects/clone`, `/create` | Make a folder, by default under `repo/`, or at `path`; `create` takes `readme` for a first commit |
| `PATCH /api/projects/:id` | `RenameProject`: the name shown; the folder stays |
| `DELETE /api/projects/:id?delete_files=&confirm=` | `ProjectRemoval`: unregisters; `delete_files` is `400` unless Orbyn made the folder, and can be `409 project_has_work` |
| `GET /api/fs/browse?path=` | `FsListing` for the folder picker; no `path` means home |
| `GET /api/threads?project_id=&archived=`, `POST /api/threads`, `GET, DELETE /api/threads/:id` | Threads; no `project_id` on create makes a scratch folder |
| `POST /api/threads/batch` | `BatchThreads` to `BatchThreadResult[]`; one failure does not stop the rest |
| `POST /api/threads/:id/delegate` | `DelegateTask`: a child thread that reports back |
| `POST /api/threads/:id/project` | `MoveThread`, before the first run; no `project_id` means a new scratch folder |
| `POST /api/threads/:id/adopt` | `AdoptScratch`: the scratch folder becomes a project in place |
| `PATCH /api/threads/:id` | `UpdateThread`: rename, pin, archive, settle, snooze, wake, unread, auto-settle |
| `POST /api/threads/order` | Save order; a stale id rejects the whole list |
| `POST /api/threads/:id/title` | Regenerate the title from the conversation. Spends engine usage |
| `GET, PUT /api/settings` | `ServerSettings` |
| `GET, POST /api/tasks` | `ScheduledTask[]`; `UpsertTask` creates or changes |
| `PUT /api/tasks/:id` | The whole `UpsertTask`; `404` if unknown, `400` for another task's `id` or another project |
| `DELETE /api/tasks/:id`, `POST /api/tasks/:id/enabled` | Delete; `TaskEnabled` pauses or resumes |
| `POST /api/tasks/:id/run` | Fire now (`202`, `{thread_id}`) |
| `POST /api/tasks/:id/webhook` | `WebhookEndpoint`: issue or rotate the token, shown once |
| `GET /api/tasks/:id/deliveries` | `WebhookDelivery[]`, newest 200 |
| `POST /hooks/:id/:token` | Public webhook; `202` accepted, `200` with a status, `404` otherwise |
| `GET, PUT /api/preferences?project_id=` | `PreferenceView[]`; `SetPreferences`, where `null` resets |
| `PUT /api/projects/:id/preferences` | Project overrides |
| `POST /api/projects/:id/pull` | Fast-forward a clean checkout |
| `GET, POST /api/keybindings` | `KeybindingsView`; add or change a `KeybindingRule` |
| `GET /api/diagnostics`, `POST /api/diagnostics/repair` | `Diagnostics`; `409 runs_active` |
| `POST /api/diagnostics/otlp` | `OtlpCheck` to `OtlpResult` |
| `GET, POST /api/storage/cleanup?dry_run=` | Last `CleanupReport`; apply the retention rules |
| `GET /api/shell` | `ShellStatus` |
| `GET /api/shell/events` | SSE `ShellEvent`, with events held for the first window |
| `POST /api/shell/actions` | `ShellRequest` (`202`, `422` with no shell) |
| `GET /api/updates`, `POST /api/updates/check` | `UpdateStatus`; a check only reads |
| `GET /api/updates/events` | SSE `UpdateStatus` on each change |
| `POST /api/updates/app/apply` | Ask the shell to install (`202`, `409 runs_active`, `422` on a server) |
| `POST /api/updates/apply-all` | `ApplyAllResult`; engines, library, app; stops at the first failure |
| `POST /api/threads/:id/runs` | Admit a run with an optional `model`, `effort` and `options` (`202`, `409 thread_busy`, `403 folder_untrusted`, `422 unsupported_option`) |
| `GET, POST /api/threads/:id/queue` | `QueuedMessage[]`; queue a message, which starts at once if idle and can carry a selection (`422 unsupported_option`) |
| `POST /api/threads/:id/queue/resume` | Release a held queue |
| `PATCH, DELETE /api/queue/:id` | Edit or remove a queued message |
| `POST /api/queue/:id/send-now` | Send next, stopping a running turn for it |
| `POST /api/threads/:id/steer` | `SteerRun`: add text to the running turn (`422` if unsupported); a selection applies from the next turn |
| `GET, POST /api/threads/:id/attachments?name=` | Raw upload body; `Content-Type` is the kind |
| `DELETE /api/attachments/:id` | Remove an attachment |
| `GET /api/threads/:id/mentions?q=` | `Mentions`: profile skills, ranked unignored files, this project's threads |
| `GET /api/search/messages?q=&project_id=&thread_id=&archived=&limit=` | `MessageSearch`: `MessageHit[]`, newest first, each with `seq` and `message_id` to open at |
| `GET /api/threads/:id/commands?skills=` | `SlashCommand[]`: Orbyn's, the engine's, its agents (`source: agent`), custom command files, and skills when `true` |
| `GET /api/questions?thread_id=&state=` | `QuestionRequest[]` |
| `POST /api/questions/:id/answer`, `/dismiss` | `AnswerQuestion`; `409 already_decided` carries the existing request |
| `GET /api/threads/:id/messages?limit=` | `ThreadMessage[]`: the newest up to 1,000, each whole, in order |
| `GET /api/threads/:id/items`, `/items/:item` | `ThreadItemRecord`: raw engine items and exit codes |
| `GET /api/threads/:id/usage` | `ThreadUsage`, last reported by the engine |
| `GET /api/threads/:id/runs/:run/changes` | `RunChanges`: files the engine reported or the agent declared, up to 200, with status and whether each can be restored |
| `GET /api/threads/:id/runs/:run/changes/file?path=` | `ChangedFileContent`: both ends as kept, never the folder as it is now |
| `POST /api/threads/:id/runs/:run/changes/restore` | `RestoreChanges` to `RestoredFile[]`: `restored`, `unchanged`, `conflict`, `not_kept`; `409 thread_busy` |
| `GET /api/network` | `NetworkRequest[]`: every automatic outbound request, its switch and whether it is on |
| `GET /api/threads/:id/files?path=` | `FileEntry[]`, one folder |
| `GET /api/threads/:id/files/ignored` | Ignored paths |
| `GET /api/threads/:id/files/search?q=&content=` | `SearchHit[]` by name or by line |
| `GET, PUT /api/threads/:id/files/content` | `FileContent`; a stale `base_revision` is `409 file_conflict` |
| `GET /api/threads/:id/files/raw?path=&download=` | Bytes with `Range`, `If-Range` and `If-None-Match`; `206`, `304`, `413 file_too_large`, `416`; `download` forces an attachment |
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
| `POST /api/threads/:id/force-stop` | `ForcedStop`: end the run now; `run_id` is empty when nothing was running |
| `GET /api/threads/:id/events` | SSE `ThreadEvent`, resumes from `Last-Event-ID` |
| `GET /api/approvals?state=pending`, `POST /api/approvals/:id/decide` | Approvals |
| `GET /api/threads/:id/diff?scope=` | `FileDiff[]`: `worktree`, `turn&run=`, `thread`, `branch&base=`, `commit&sha=` |
| `GET /api/threads/:id/commits` | `CommitInfo[]`, newest 100 |
| `GET /api/threads/:id/checkpoints` | `Checkpoint[]` |
| `POST /api/threads/:id/restore` | `RestoreWorkspace`; `409 shared_directory`, `409 thread_busy` |
| `POST /api/threads/:id/rewind` | `RewindThread`: continue from before a run |
| `POST /api/threads/:id/fork` | `ForkThread`: a child thread with the log up to a run |
| `POST /api/threads/:id/switch-engine` | `SwitchEngine`: hand the conversation to another engine, with an optional selection |
| `GET, POST /api/threads/:id/previews` | `PreviewTab[]`; `OpenPreview` |
| `DELETE /api/threads/:id/previews/:tab` | Close the tab and its browser |
| `POST .../previews/:tab/navigate`, `/control`, `/input` | `NavigatePreview`; `PreviewControl`; `PreviewInput`, `400` until a person holds the page |
| `POST .../previews/:tab/history`, `/resize` | `StepPreview`; `ResizePreview`, `400` outside 100 to 4096; both to `PreviewTab` |
| `POST, DELETE .../previews/:tab/recording` | Start; stop, to `PreviewRecording` |
| `POST .../previews/file` | `OpenPreviewFile` to `PreviewTab`, inside the checkout |
| `POST .../previews/:tab/view`, `/reload`, `/clear`, `/pick` | `PreviewView`; `ReloadPreview`; `ClearPreview`; `PickPreview` to `PickedElement` |
| `GET, POST /api/browser-profiles` | `BrowserProfile[]`; `CreateBrowserProfile` |
| `DELETE /api/browser-profiles/:id`, `POST .../clear` | Remove, or empty, a profile no tab has open |
| `GET /ws/preview/:thread_id/:tab` | Base64 JPEG text frames |
| `GET /api/threads/:id/servers`, `POST .../servers/:pid/stop` | `LocalServer[]`; stop one in this checkout, otherwise `404` |
| `GET /ws/terminal/:thread_id` | Main PTY: binary in/out, JSON text frame `{cols,rows}` resizes |
| `GET /ws/terminal/:thread_id/:terminal?observe=` | Attach to a named terminal; `observe` is read-only |
| `GET, POST /api/threads/:id/terminals` | `TerminalInfo[]`; `OpenTerminal` with `split_of` and `direction` |
| `PATCH, DELETE /api/threads/:id/terminals/:terminal` | Rename, close |
| `GET, DELETE /api/threads/:id/terminals/:terminal/scrollback` | `TerminalScrollback`; clear |
| `GET, POST /api/threads/:id/scripts` | `ProjectFileView`; `RunScript` to `TerminalInfo` |
| `GET /api/engines`, `POST /api/engines/refresh` | `EngineStatus[]` |
| `POST /api/engines/:id/update` | Run the owning installer (`409 engine_busy`) |
| `POST, DELETE /api/engines/custom[/:id]` | ACP, AG-UI and terminal engines |
| `GET /api/acp/registry?q=` | `AcpRegistryEntry[]`, with how this machine can install each; `502` if unreachable |
| `POST, DELETE /api/acp/registry/:id` | `InstallAcpAgent` to `EngineStatus`, `422` if refused; remove, `409 engine_busy` |
| `GET /api/skills`, `POST /api/skills/rebuild` | Library skills; rebuild only re-reads them |
| `GET, POST /api/skills/profiles`, `DELETE /api/skills/profiles/:id` | Profiles |
| `GET /api/usage?days=` | `UsageReport` from local history, rescanned on each read |
| `POST /api/usage/refresh?days=` | Forgets scans and limits, then reports |
| `GET /api/limits?force=` | `LimitsOverview`: pooled windows, each engine, and what could not be read |
| `GET /api/engines/:id/limits?force=`, `GET /api/threads/:id/limits?force=` | `EngineLimits`; `422 unsupported` if the engine reports none |
| `GET /api/engines/:id/models?refresh=` | `EngineModels`: models with their options, engine-wide options, agents, output styles, `remembered` |
| `GET, POST /api/policy/rules`, `DELETE /api/policy/rules/:id` | Internal: diagnostics only, no client uses these |
| `GET /api/audit?thread_id=&limit=` | Internal: diagnostics only, no client uses this |
| `GET /api/computer`, `POST /api/threads/:id/computer` | Status, and a governed action |
| `POST /auth/session` | Exchange a remote access key for a cookie (`204`) |
| `POST /agui/threads/:id` | External AG-UI endpoint (`RunAgentInput` in, SSE out) |
| `POST /mcp/:thread_token` | Per-run MCP server |
