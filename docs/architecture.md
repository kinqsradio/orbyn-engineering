# Orbyn Engineering app architecture

Orbyn Engineering is a local-first workbench that wraps coding-agent CLIs in
Orbyn skills and per-session governance. Desktop and web are both clients of one
core service. The product never proxies model traffic and never reads engine
credentials.

## Owners

| Owner | Path | Owns |
| --- | --- | --- |
| Wire contract | `crates/orbyn-contracts` | Serialized types shared with the UI; generated TS in `web/src/generated` |
| Core | `crates/orbyn-core` | Store, run lifecycle, policy, audit, skills, engines, git, terminal, computer gateway, in the capability groups its [README](../crates/orbyn-core/README.md#groups) lists |
| Service | `crates/orbynd` | HTTP/SSE/WebSocket transport, static UI, access control, CLI entry point |
| Workspace | `crates/orbyn-core` `project::workspace`, `project::projects` | Library checkout, target boundaries, library updates, project intake |
| UI | `web` | Task flows only; it holds no authority and no lifecycle rules |
| Desktop shell | `desktop/src-tauri` | Spawns `orbynd`, loads stable bundled UI assets, tray, app updates and what only the OS can do |

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
- A stop is saved before anything is signalled. Stop acceptance and terminal commit
  share the immediate database writer: an accepted stop wins over a later startup
  failure or engine completion and commits `cancelled` without a failure message.
  Already-terminal or foreign-owner runs cannot acquire a phantom stop. Terminal
  followups use the committed outcome: only completion clears matching-engine
  handoff, and only failure records sign-in or usage-limit/auto-resume state.
  Session-loss recovery also checks the saved stop inside its mutation transaction,
  so it cannot replace a stopped run's provider session or handoff. Rejected steer
  callbacks record their note and queued prompt atomically against the source run's
  epoch and thread. A stopped or terminal source keeps that prompt held without a
  preparation owner, so a later retry cannot release it or launch work implicitly.
  Recovery closes tools the dead process
  left open with a note. A run still `admitted` never reached an engine, so its message
  returns to the front of the held queue, without attachments, and is not resent on its
  own. A later state may have reached the engine and is never resent.
- A Claude Code workflow (the CLI's `Workflow` tool) runs in the background past the
  turn that launched it, and closing the CLI's input would end it. So a Claude run whose
  turn completes while a workflow it launched still runs stays `running`: it ends with
  the follow-up turn the CLI starts when the workflow finishes, or five seconds after the
  last one ends with no follow-up turn, as after a stop. A failed turn is not held. The
  workflow's handles are kept as a `workflow` item beside the call, and its states
  arrive as `CUSTOM workflow.state`. Stopping one sends the CLI's `stop_task` control
  request through the live run after a `workflow.stop` audit row, and a stop that never
  reaches the engine adds a `workflow.stop_failed` row; acceptance is not the end, which
  the CLI reports as `stopped`. Stopping the run still ends everything, and a workflow
  still running when its run ends is reported `stopped`. The delegated-run silence
  watchdog does not count a run waiting on a running workflow as stuck.
  The script view reads an inline script from the call, and otherwise only a `.js`
  regular file whose resolved path is inside the CLI's own `projects` or `workflows`
  folder or the thread's checkout, cut at 256 KiB. Nothing else in the CLI's config is
  read, so hard rule 1 holds.
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

Project folders in the thread sidebar use the same local project-scope catalog as
settings. The client sends its repository, repository-path or separate recipe and
any per-project overrides; the service reads sanitized Git identity, and the browser
performs no Git read. Checkouts of one folder keep their threads under its label.
Project and thread sort remain client preferences, as does the saved open state of
folders. A failed or partial catalog leaves an unobserved checkout in its own folder
instead of hiding it or widening a group, and grouping changes no registration,
trust or project file.

A run that fails on a usage or rate limit leaves a limit on its thread: the engine's
words, when it stopped and the reset if the engine gave one. Any new run, settle or
archive clears it. With a reset in the future, `auto_resume_limited_threads` schedules a
continuation and `snooze_limited_threads` snoozes until then; each can also be chosen on
the thread. Due continuations start from the lifecycle pass, so an overdue one starts on
the first pass after a restart, and a held queue stays held until that run ends.

## Composer

Above the message box, provider status follows the selected engine's service
report: missing installation, a reported problem, signed-out state, or an update
in progress. Unknown authentication alone produces no signed-out warning. The
banner follows status changes after the existing explicit provider refresh;
this adds no automatic engine polling or authenticated probe.

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
first. Plan mode refuses file changes, runs Claude in `plan` and Codex with both
the read-only sandbox and native `collaborationMode: plan`. Ordinary Codex turns
explicitly select native `default` mode, including when resuming a plan session.
Mode settings retain the selected model/effort or the effective settings returned
by `thread/start` or `thread/resume`; a missing required model is an error rather
than an invented default. Built-in mode instructions and Orbyn's separate thread
context are both retained. The collaboration mode does not widen permissions.

`response_streaming_mode` (a device choice, never per project) `turn` holds a reply's text until that message ends;
`paragraph` is the default and writes it as it comes, merged over 33 ms. Reasoning and
tools always go out as they happen. Steering answers `delivered` or `queued`: an engine
with no mid-turn input takes it on the next turn, and an engine that refuses one sends it
to the queue with a `steer.failed` note. A typed decline carries its words only on
engines with `decline_feedback`, which today is Claude; elsewhere the message queues.

Attachments stay in app data, never in a target, and are removed with their thread.
The limits are 100 per thread, 10 MiB per image, 80 MiB of images and 50 MiB per other
file. A record exists only once its bytes are in place, and a message naming an
attachment that is not ready is refused before anything is admitted. Before its engine
starts, a run logs `CUSTOM user.attachments` with each record's id, name, media type
and size, so a transcript shows what the message carried without asking the engine.
`GET /api/attachments/:id/content` returns those bytes while the record lives.

The composer edits a fenced code block as plain text: Tab and Shift+Tab move the
selected block's lines by two spaces, Enter from the block's empty last line closes
the fence and puts the caret past it, any other Enter adds a line and only Mod+Enter
sends, and a picker on the opening line names or clears the language. Tab outside a
block keeps the list and focus rules.

Context can sit above the draft as a chip: a cited reply, a terminal selection, a
review comment on a diff line or range, a picked page element, or the open file at
its revealed line. A chip is not engine protocol; when the message is sent, each
chip becomes a readable block at the top of the prompt and the typed draft follows.
A terminal selection inside one command's output also carries that command line and
exit code when the shell marks its commands with OSC 133 or 633 shell-integration
sequences. Orbyn installs no shell integration, so a shell that emits no marks gives
the selection alone.
Copying one chip, or all of them, writes Orbyn's JSON inside an HTML form plus
plain prompt blocks, so a paste into a composer restores the chips and refetches a
file whose text was not carried. Ordinary text, broken JSON and half-known chips never become chips.

File source annotations use review chips with a captured line range, source excerpt
and comment. The chip opens its captured details for editing or removal; neither
action changes the file. A successful send, queue or steer consumes only chips whose
values still match the submitted snapshot, so editing a chip with the same ID while
the request is in flight preserves that edit. New chips and newer draft text stay.
Review comments, like terminal context, cannot be consumed by local commands,
compact/goal commands, side chats or approval replies that do not carry context.

A terminal selection also records the one-based buffer rows it covered, so its
chip and prompt block name those lines instead of the whole terminal. Chips count
as part of the message, not as text beside it: the 120,000-character limit covers
the complete prompt, a selection that would push it over is refused rather than
added, and while a terminal chip is attached the composer refuses every local
command, `/compact`, `/goal`, side chats and approval replies, keeping both the
draft and the chip instead of consuming either. Captured output is plain text and
is never reread from a running terminal.

After a Claude thread has sat idle past its prompt-cache window, returning to it
offers one compact action before the next turn. The window is the lifetime Claude's
last usage report says its cache write used: an hour when `cache_creation` counts
one-hour tokens, otherwise Anthropic's documented five minutes. It is not offered
while a run is active, and no other engine has that cache, so none is offered it.

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

The provider card offers Refresh models even when discovery returned no models.
It asks with `refresh=true`, keeps the available list while loading or after a
transport failure, and shows a retryable discovery error. A later refresh owns
its result: an older response or failure cannot overwrite it. These caches stay
in process memory; this does not add a hosted manifest or a cache across restarts.

A selection is a model, an effort and `options` by `ModelOption` id: `service_tier`
(`default` is Standard), `fast_mode` (`on`, `off`), `mode` and `config:<id>` for ACP.
It belongs to the thread, is set by `PATCH`, by a turn, or by a queued message when that
message starts, and an empty string goes back to the engine's default. A steer leaves
the running turn alone and applies from the next. A fork keeps the selection. An engine
switch takes what was asked for, then what was last chosen on that engine, and never
keeps the old engine's values. The last selection used on an engine is remembered and
reported as `remembered`. A new thread takes the request's model, then the project's
`default_model` (when `default_engine` is empty or matches), then the remembered one.
Effort and options carry only along with their model: the request's own, then the
project's `default_effort` and `default_model_options` when the thread's model is that
default model, then the remembered ones for the same model. `default_model_options`
holds option ids with one string value each and never `effort`, which has its own key.
The device's `default_permission_mode` also applies there; it is not set per project.

The new-thread draft resolves that physical project's effective model preferences
before sending an implicit selection. A model picked in the draft wins over a
late defaults response. A disabled or missing configured provider requires an
explicit replacement; it never silently selects another provider. Draft effort
and options remain attached to their project and model; when the draft's model is
the project's default model, its default effort wins over the remembered one, and
the service fills the default options. Settings opens over the
still-mounted draft, so every successful preference save bumps a session-only
revision that makes the draft read its defaults again; an explicit draft choice
stays.

Admission refuses a value the model does not offer with `422 unsupported_option`, and
stores nothing. A model the engine did not list may be custom, so only engine-wide
options are checked for it. `PATCH` does not check, because a model and its effort
change in two steps. A run's start checks again, which is what catches a queued message
that outlived a model; that run fails with the same message.

`fallback_model` covers a model that went away. It may be set per project, and a turn
reads it in its thread's project. When the engine's own list, not a stand-in,
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

## Timeline rendering

Tool outcomes are distinct from execution exit codes. Drivers publish the existing
`CUSTOM` event `tool.outcome` with `{toolCallId, outcome: "success" | "failure"}`
only when the engine reports a supported outcome: Claude's `tool_result.is_error`,
ACP's terminal tool status, or Codex's explicit completed/failed status or exit
code. Command exit codes still use `tool.finished`; an actual nonzero code remains
a failure. No new exit code is synthesized. Older logs and unsupported outcomes
stay unknown. Group and finished-turn summaries count only reported successful
actions, list failures separately, and use neutral wording for missing results.

Consecutive work groups contain at most five tool calls and at most thirty
activities including reasoning. The live view retains whole recent groups within
thirty activities, preserving group keys and expanded state as calls arrive. Older
groups are deferred in place, separated by messages and approvals; opening their
fold reveals them. Finished turns retain their searchable mounted content.

The surface add menu opens existing Browser, Files, Diff, linked pull requests and
side-chat surfaces. Terminal opens the existing drawer. Individual Pull request
and Device entries remain disabled because those surfaces are unavailable. Browser
mute is not offered because the preview protocol has no mute capability. Existing
close, resize, maximize and small-screen behavior remains owned by the pane.

## Questions

An engine question holds its run in `awaiting_approval` until it is answered,
dismissed, timed out or the run ends, and all of those close it. A run returns to
`running` when no approval and no question is open. Codex's
`item/tool/requestUserInput` and Claude's `AskUserQuestion` both arrive here; Claude's
goes through the same `approve` callback, so it stays on the MCP gate. A dismissal
reaches Codex as an empty answer set and Claude as a denial. Questions are logged as
`ACTIVITY_SNAPSHOT` with `activityType: "question"`, whose content isthe `QuestionRequest`. A secret answer goes to the engine and is stored only as
`[hidden]`, so it never reaches the database or the event log. A custom answer may
carry files already uploaded to its thread, keyed by question; they stay with the
settled question record and are refused when they belong to another thread. No
engine's answer has a place for files: Codex takes a list of strings per question
id, Claude's `AskUserQuestion` takes one string per question, and an ACP agent asks
no questions, only permissions answered with an option. So the typed answer reaches
the engine and the files stay in the record.

Question Markdown uses a question-only remote-image link policy: a remote media
URL becomes an ordinary link without mounting an image or video. General message
media retains its own policy. Markdown tags stay inert text; strict Mermaid is the
supported diagram path. Questions gain no arbitrary HTML/SVG execution surface.
Agent-published HTML renders retain their separate publishing boundary.

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

Each engine lists the modes it offers in `capabilities.permission_modes`, from
`permission_modes::offered`: OpenCode offers Supervised, Auto-accept edits and Full access,
since it has no classifier and its Auto would equal Supervised; fx would offer Supervised
and Auto, Muse Supervised and Full access, and Pi Supervised, Auto-accept edits and Full
access; every other engine offers all four. A thread keeps the mode it was given, but a
run on an engine that does not offer it runs Supervised, never the nearest looser mode,
and the composer shows and offers the same. Every run launches its own engine process
with the mode stated, so a mode change takes effect from the next turn's process.

Parsers are tested against recorded real frames in `driver/fixtures`, named by version.
`cargo test -p orbyn-core live_ -- --ignored` reads each installed CLI's real catalog,
with no prompt.

## Warm next turn

With `warm_next_turn` on (off by default, with no control of its own), a completed
Claude turn starts the process the thread's next turn would launch, with the same
arguments, folder, MCP URL, settings and mode, and leaves it idle on its input. No
prompt is sent, but the CLI still does its launch work at once: Claude Code 2.1.318
ran a `SessionStart` hook before any input, and it starts the person's MCP servers the
same way, so a process that is never adopted runs them for nothing. That is why it
is off unless asked for. The next run on that
thread adopts it only when it is the run right after the one that started it, the
process is still alive, and every launch input gives the same key, which also names
the CLI's path, size and modified time and the `prefer_saved_login` state. Anything
else ends it unused and launches as usual. Its MCP token carries the thread's write scope
but no run until a run adopts it, and is revoked whenever the process goes unadopted:
after five idle minutes, at shutdown, or when any engine update begins, since
instances can share the binary and Windows cannot replace a running one. An update
cannot begin while a warm process is being started, and none starts during an update. A run that adopts logs `CUSTOM
engine.warm`. Other engines launch per run as before.

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
cost and is never guessed. History is kept by day, model and service tier (Claude's
`speed`/`service_tier`, Codex's turn `service_tier`; unknown names are `other`). A
price applies to one tier, absent meaning standard, and another tier never borrows the
standard rate, so its tokens stay unpriced. Each estimate is also split by token type. Unchanged files are served from memory. The Usage page keeps
the same period's figures and chart during an explicit local refresh, dimming them
after 150 ms while the scan is pending. A failed refresh keeps those figures and
offers Retry. Changing the period clears them, and an earlier response cannot
replace the new period or clear its pending state. Subscription
limits appear only where an engine reports them itself, as Codex does through
`account/rateLimits/read`, cached for five minutes. Only Codex's `rateLimits`,
`rateLimitsByLimitId` and plan leave the driver; its account ID, upsell copy and
reset-credit offers are dropped; `?force=true` reads again and
spends no model usage. `/api/limits` also gives one number per window length across
engines, the highest used percentage, since that engine stops first.
Windows with an unknown duration remain separate, because an absent duration does
not establish that they share a budget.
Claude uses its unmodified CLI's promptless `initialize` then `get_usage` control
requests in the same isolated probe as model discovery. Initialization and usage have
separate bounded deadlines, and the child is stopped and reaped before its temporary
folder is removed. Only reported subscription windows and the named plan leave the
driver; account, session and behavior blocks are discarded. An unavailable, unsupported
or unusable report stays unknown. No credential file or SDK is needed by Orbyn.

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
folder. A fork and an engine switch cannot carry an engine session, so each ends it
and leaves a handoff of up to 16,000 characters, oldest text dropped first, for the
next run. A rewind does the same unless the engine rolls its own session back. Dropping the session and writing the handoff share a transaction. It
stays until a run that carried it completes, so a failed start, a stop or a restart
leaves it pending, and until then `/compact` and `/goal`, which reach an engine bare, are
`422 unsupported`. The log stays whole; a rewind is logged as `CUSTOM
thread.rewound` for clients to hide what follows.

Each run keeps the engine session and the first turn id it spoke in. No run is admitted
while a rewind is under way. Rewinding a Codex thread before a run whose session is
still the thread's, with no handoff waiting and an earlier run in that same session (a
session's first run may have carried a handoff), loads
that thread in a short-lived app-server and sends `thread/revert` with that run's turn,
which keeps only the earlier turns. The session then goes on, nothing is handed off,
and the event and audit carry `native: true`. Files are restored only by the rewind's
own checkpoint step. Any refusal, a missing turn id or another engine falls back to the
handoff above.

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

An explicitly confirmed Git action may leave its commit message, pull request
title or description blank to generate that field from bounded local change
context. Nonempty user text is kept unchanged. Opening, typing, cancelling and
push-only actions never generate text. Every missing field is parsed and validated
before staging, pushing or creating a pull request. Changed branch/base or working
files, revoked project trust and an active run refuse the action after generation;
existing phase receipts still describe any earlier completed effects. There is no
automatic rollback of user work.

Generation never blocks the action. When it fails for any reason about the change,
the model or its reply (too large, unsupported text, a symlinked reference, a
timeout, no model, an unparsable reply), each field still blank falls back: the
thread title for a commit message or pull request title, and an empty description.
Fields generated before the failure stay. The result carries a notice that says
why. A busy, archived, untrusted or changed thread and an engine turned off still
refuse the action. A reply may be bare JSON or one Markdown fence around it. Generation
needs Git 2.40 or later, which honours `GIT_ATTR_SOURCE`; older Git could apply
the working tree's clean filters while the diff is read, so it falls back instead.

Writing uses the selected thread engine and the configured text-generation model,
or the thread's explicit model when that setting is empty. It never chooses another
provider or guesses a smaller model. Only the guarded Claude one-shot path supports
repository-derived text: an owned temporary folder, empty tools, strict empty MCP
configuration, disabled hooks/cloud MCP/IDE connections and slash commands,
`dontAsk`, and no session persistence. Rejected flags fail without a retry.
The guarded path is a separate driver call (`write_text`); the shared one-shot used
for thread titles keeps its original flags. Codex and unproven drivers never
generate: blank fields keep manual behavior there (a blank pull request title falls
back to the thread title, a blank description stays blank, a blank commit message is
refused). With a writing engine, a typed pull request title is kept and only the
blank description is generated. Pull request context diffs against the upstream
remote's tracking ref (the branch's configured remote, else `origin`) when it
exists, else the local base branch; the staleness check uses the same ref. The
checked snapshot includes the symbolic branch name (a fixed marker on a detached
HEAD), so switching branches at the same commit during generation is refused.
Existing title calls retain their separate model policy and
Codex path; this change does not qualify that path as tool-free. No credential
configuration or MCP server list is read to implement writing. Prompts and patches
are not saved by the generation audit, which records purpose, engine and model.

The inherited `source_control_writing_style` preference selects repository
conventions, Conventional Commits or custom instructions, and whether to follow
change-request templates. The empty legacy object keeps repository conventions and
templates enabled. Repository mode reads bounded recent subjects and checkout-root
AGENTS.md; custom mode uses only the person's writing instructions. Templates come
from a regular file in the selected base tree, never a remote fetch or a symlink.
Oversized context, unsafe references and malformed settings fail with a manual
path rather than silently omitting required writing context.

Forge work goes through the forge's own CLI, chosen from the origin host: `gh`,
`glab`, `az` and `tea`. Orbyn holds no forge credential and reads none, so an unknown
host is treated as GitHub Enterprise through `gh`, and a missing CLI is
`422 unsupported`. Bitbucket has no CLI to go through and needs an API token, so it
reports that and stays `422`. GitHub and GitLab cover the full pull request surface
through `gh api` and `glab api`. Azure DevOps and Forgejo cover list, read, open,
merge, close and reopen; anything else is `422`. Arguments are passed directly and no
shell parses them, and comment and thread ids that go into API paths are checked to
be plain.

The base pull request list asks the forge CLI for exactly the fields it always has, so
it is as fast as before, and it never waits on anything below. A row's `checks` (total,
passing, failing, running and up to 20 failing names) are counted from the check data
that call already carries; a check run counts as running until it is `COMPLETED`, then
`FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED` and `STARTUP_FAILURE` fail,
`SKIPPED`, `NEUTRAL` and `STALE` count only in the total, and a commit status of
`PENDING` or `EXPECTED` is running. `checks_state` is derived from the same counts.

The rest comes from `POST /api/pulls/details`, which the caller makes after it has shown
the list. The body names the listed rows (`project_id`, `number` and the row's
`updated_at`) and may set `fresh`. The answer holds, per row, `created_at`,
`requested_reviewers` (users and teams), `comment_count` (conversation comments plus
inline review comments) and `viewer_review_state` (the signed-in login's latest review, or
`none`). GitHub answers all of a project's rows with one batched GraphQL request, which
also names the viewer, so the review state needs no other call. A field is absent when
unknown, never zero or partial. A row is left out whole when its project cannot be read,
its own batch yields no data for it or its forge has no details; only GitHub has them.
Repeated rows count once, at most 100 rows are read per request (later ones are ignored),
and a project is asked in queries of at most 25 rows, so one failed or partly erroring
query costs only the rows it did not return.

Details known for a row are reused while its `updated_at` is unchanged (it moves with every
comment, review or request) and for at most 10 minutes, so scheduled and background refreshes
ask only for new or changed rows, and for none when every row is known. A refresh the person
starts sets `fresh` and asks again for every row. If GitHub's rate limit is spent, the answer has
no details, `paused` names every withheld field as it appears on the row (`created_at`,
`requested_reviewers`, `viewer_review_state`, `comment_count`), and details are not asked
for again for 2 minutes, `fresh` included. `ForgeStatus.viewer` is the login the CLI is
signed in as, read on each `GET /api/forges` rescan.

A git action runs commit, push and pull request in order, logs each phase as `CUSTOM
git.phase`, and stops at the first failure; earlier phases stand. These are the
user's own commands, so unlike Orbyn's internal reads they run commit hooks. All of
it needs a trusted folder, and writes wait for the thread's run to end. Like the Git
runner, every forge CLI call owns a process group or Windows job: helpers the CLI leaves
behind stop when it exits, when the call is cancelled and when
the service stops. Every forge write is audited before it happens. A stack is the chain of open pull requests whose
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

A review guide is an agent's stop-by-stop reading order for one pull request, also
this service's own. Orbyn does not generate it itself: writing a guide starts an
ordinary thread in the project root, linked to the pull request, whose first message
asks the agent to read the change through the forge CLI, change nothing, and call
`orbyn_pull_guide_write` with the head commit. The write goes through the approval
gate like any other tool effect. Starting one is refused while the project's
`review_guides_enabled` preference is off. The project's `review_guide_instructions`
are appended to that message, and the thread runs on the asked model, else the
project's `review_guide_model`, else the engine's default. A guide naming an older head commit than
the pull request is shown as not covering the newer commits; nothing else checks it.
Asking about one stop opens a new thread in the project root and hands the stop back
as that thread's composer draft; nothing is sent until the person adds a question
and sends it.

A Jujutsu checkout that is not colocated with Git (a `.jj` folder with no `.git`
beside it, found from the thread's folder upwards but never above the project
folder, so a project inside a larger jj repository is not read as it) is a non-Git project, read
through the person's installed `jj`; Orbyn ships, links and installs no jj, and a
missing `jj` is `422 unsupported`. It reads the working-copy change (`jj log -r @`
with a fixed template) and its diff (`jj diff --git -r @`, jj's built-in Git
format, so no configured diff tool runs), always with `--no-pager`, no colour and
the file monitor off. Like any jj command this snapshots the working copy into jj's
operation log, so it needs a trusted folder. That is the whole jj surface: the
worktree diff scope and `GET /api/threads/:id/jj`. Commits, bookmarks, worktrees
(jj workspaces), checkpoints and forge actions stay Git-only; a colocated checkout
is a Git project.

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

The engine console (`POST /api/threads/:id/console`) opens the engine's own
interactive CLI, unmodified, in the thread's `engine-console` terminal on the session
Orbyn's runs resume: `claude --resume <session> --permission-mode default|plan`, from
the library like Claude's runs and with `--add-dir` for another checkout, or
`codex resume <session> --sandbox <run sandbox>|read-only --ask-for-approval on-request
--cd <checkout>`. The thread's model follows with `--model`. The program is the one runs
use, an instance's override included, resolved through `PATH` and Windows shims and
started without a shell; a session or model that could read as a flag is refused. The
engine's own login and permission prompts apply: Orbyn reads no credential and nothing
the console writes, and its approval gate and full-access modes do not reach it. Other
engines have no resumable console and are refused with `422`, as is a thread with no
session yet. The console owns the session while it runs: opening one is refused while
a run is active, and while it is alive every run admission, queue drain and preparation
retry is refused with `409 console_open`. Both checks take the workspace admission lock.
A second open returns the live console. Queued messages wait for the next send or
resume after it closes.

A viewer attaches to a terminal ID and its process creation timestamp. Rerunning
an action preserves the tab's stable ID but replaces its process; the viewer
reattaches even when that tab stays selected. Ordinary metadata refreshes preserve
the existing connection.

Child exit does not close a terminal's output socket. The PTY reader records
natural output completion only after its last scrollback and broadcast append;
the socket drains queued chunks before closing. Late observers replay the retained
scrollback and close when that stream has ended. Writes and resizes require a live
direct child and an open output stream; draining retained output grants no input
authority, and observers remain read-only. Broadcast overflow retains the
bounded latest chunks and emits an internal diagnostic, not a complete-history
guarantee. Explicit terminal close or thread cleanup ends observation promptly
even if an inherited PTY descriptor delays EOF. Process termination retains its
existing process-group/job ownership; detached descendants are not newly claimed
by this output fence.

On Windows, direct-child completion retires the retained ConPTY master on the
child waiter thread. Retaining that handle would otherwise keep its output pipe
alive while observers wait for EOF. The independent reader continues draining the
final console frames and alone records natural output completion. Console teardown
runs outside the master lock; it can block on drained output on older Windows.
Closing this owned console may also terminate still-attached console descendants
when the direct child exits. Unix keeps its existing inherited-PTY lifetime. This
is the supported legacy ConPTY lifetime contract, not a claim of byte-identical
native reference timing. Microsoft's [ClosePseudoConsole contract](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)
requires output to keep draining during teardown. Its newer
[ReleasePseudoConsole API](https://learn.microsoft.com/en-us/windows/console/releasepseudoconsole)
requires Windows 11 24H2 or Server 2025 and is unavailable on Windows Server 2022.

Project configuration reads preserve the registered canonical checkout as authority;
a checkout replaced by a symlink before the request cannot redirect that root.
Only fixed root filenames are considered, with `orbyn.json` before `t3.json`.
Directories are skipped; a present malformed, oversized or aliased first file
reports a problem and cannot silently expose the next file. The read-only open
rejects symlink/reparse aliases, verifies the actual handle's exact expected path
and regular-file identity before bytes, probes at most 256 KiB plus one byte,
then verifies that handle again before parsing. Unix read opens are nonblocking,
so a regular-file-to-FIFO race cannot wait for a writer. These path checks do not
claim arbitrary hardlink provenance or make concurrent filesystem contents atomic.
The parser consumes already checked text and never writes project configuration.

The project file is `orbyn.json`, or `t3.json` when a repository already has one, at
the checkout's root. Orbyn only reads it, and a bad file is reported and never half
applied. A script runs in its own terminal through the login shell, or `cmd /C` on
Windows. The command comes from the effective saved script list, never the request,
and it needs a trusted folder. Scripts resolve Project → Environment → actual
thread-checkout file → Default. An explicit empty list suppresses inherited scripts;
Inherit removes that override. Both script menus, explicit execution and worktree
hooks use this same resolver. The scripts response keeps the actual file content in
`file` and exposes the effective list separately in `scripts`; settings never rewrite
the file. Opening a script terminal preserves its selected tab while the terminal
list refreshes. Malformed files block execution, and script lists require unique nonempty
names and nonempty commands. The action editor preserves a named script's
role and options when editing its command. Every saved action list, for the
environment or a checkout, writes a `project.actions.save` audit row in the same
transaction and before the write: the scope (`all_projects` or the project id),
whether it reverts to Inherit, and each action's id and name. Commands are not copied
into the audit log. Running an action is audited as `script.run` and opening a file in
an editor or file manager as `file.open`, each before the effect. Both manual script menus open a new
Browser tab after successful command launch when `auto_open_preview` is enabled
and `preview_url` is set. The existing preview API validates the URL and owns its
browser process. The new tab is selected without replacing another page; preview
failure is reported separately from the already-started command. A late preview
response does not switch surfaces after the user navigates to another thread.
The version-fenced settings API also accepts targeted action add, update and
remove operations. Each selected checkout starts from its own effective list;
adding to Mixed actions preserves every member's other commands. Duplicate names,
missing edit targets or invalid commands reject the whole group. The same membership
and row revisions fence these edits; project files and unselected project overrides are
not rewritten. An update preserves unknown fields on the selected action.
The settings action form edits names, commands, icons, setup/wait/settle flags and
preview options through these operations. Environment defaults, logical groups and
physical project dialogs use the same version-fenced writer. A Mixed group offers
Add action without treating one checkout's list as the group's list. A failed save
keeps the draft and reports the error; closing the form does not imply a successful
write. The Name field receives focus after the native modal enters the top layer.
After closing the form, focus returns to its opener once the refreshed controls
are enabled; renaming or deleting the opener's action returns focus to Add action.
Deletion requires confirmation. An action's optional `id` is independent of its
editable name and command. Readers derive a deterministic SHA-256 identity from
the exact legacy name when it is absent, without writing project files or stored
lists. New targeted saves materialize the ID; an edit preserves the observed ID
across renames and rejects a request to change it. The same named legacy action
has the same derived identity across checkouts, while names that collapse to one
display slug remain distinct. Explicit IDs must be unique within a list and
contain 1–128 ASCII letters, digits, hyphens or underscores.
Manual terminals use the validated ID rather than a simplified display name, so
running similarly named actions cannot replace each other's terminal or process.
This is an additive reader/writer expansion with no database backfill or schema
change. Existing writers may still replace a whole list, and legacy data remains
readable; targeted editing is the identity-preserving operation. The data-directory
lock continues to admit only one Core writer. Scoped settings expose derived IDs
in the editable action value, while raw environment/member/override layers still
form the revision digest; reading the editor does not backfill stored lists.
The run endpoint accepts exactly one saved action ID or legacy name. Both paths
resolve the current effective command in Core and check folder trust before spawning.

The action editor's Keybinding field captures the environment-wide shortcut for
`script.<id>.run`. The existing keybinding file remains its owner. Core serializes
its read/modify/atomic-rename writers so unrelated concurrent edits survive;
external manual file edits do not share that writer lock. Saving action metadata
and saving the shortcut are separate effects. If the second fails, the action
remains saved, the form becomes Edit Action and retains the shortcut draft. A retry
updates that action rather than creating a duplicate. Removing one project's action
does not delete its environment-wide binding, which other projects can share.

Only this thread's available action commands register handlers. While its catalog
is still loading, a pressed action shortcut resolves that ID through a fresh Core
read. A route epoch cancels delayed work on navigation or unmount; modal dialogs
and repeated keydown events cannot launch actions. Terminal key reservation uses
the dispatcher's live focus and `when` context plus the active thread's handler
eligibility, including its pending catalog reader. Plain action keys remain terminal
and text input keystrokes. Menus and shortcuts share execution, select the resulting
terminal and then apply preview options. Terminal selection is transient viewer
state and never an authority to run a command. Complete action parity still needs
final integrated native/Windows qualification.
The first `run_on_worktree_create` or
`run_on_settle` action runs in its worktree; later matching actions are not run.
Setup has its own terminal, distinct from manual execution, and each settle gets
a fresh terminal. A setup's `async` defaults to true. The first admitted turn waits
until its captured setup is started; `async: false` also waits for exit code zero.
Engine title generation follows that same gate. Startup failure or unsuccessful
synchronous setup fails the first turn; an async exit does not block it,
and a later explicit user message does not implicitly execute project code again.
The thread view shows the setup as a card: starting, running (saying when the first
turn waits for it), finished with its exit code, or stopped. `stopped` means it
ended with no exit code, by a cancel or a service restart. Its Output button selects
the setup terminal, and a successful setup's card leaves after a few seconds. Cancel
stops a setup this service is preparing or running, kills its process tree, is
audited as `setup.cancel`, and is not a run cancel: a synchronous setup then fails
the first turn as an unsuccessful preparation, which keeps its Retry, while a
cancelled async setup leaves the thread free. Cancelling a finished or stopped
setup changes nothing; a thread with no setup is `404`. An async setup's exit is read from its process; only the
waiter of a synchronous setup records an exit.
Failed preparation keeps queued messages held, including messages added after the
failure. A later user turn does not release that hold, and queue resume or automatic
restart/limit continuation cannot bypass it. The failure's timeline Retry control
uses its run identity to retry the captured preparation, original prompt and
attachments, engine instance and model/effort/options selection. Core admits a
fresh attempt without changing terminal run history;
a normal prompt never retries project code. An active run, stale failure identity,
untrusted project or missing legacy capture rejects retry before a process starts.
The complete capture is compared again in the admission transaction. A fresh
catalog must validate the saved selection before project code starts; a missing
non-custom model or catalog error refuses retry. The captured provider is checked
again under engine admission, with no current-provider or fallback-model substitution.
Claude, Codex, ACP and terminal drivers check their effective local executable with
the existing Windows-aware launch resolver before setup and under admission. This
check starts no version, sign-in or project command; named instances check their
resolved program override. Endpoint drivers have no local executable. This proves
known launch availability only: runtime and endpoint failures can still occur.
The current thread's selection and remembered engine choices are preserved. Runtime
permission and plan policy come from the thread's current transaction snapshot,
never from the old capture. A queued first turn captures its applied selection and
attachments in the same transaction. Duplicate requests lose the same atomic
admission fence. A retry's engine turn
waits for its setup, including exit zero for synchronous actions. Only successful
preparation releases queue holds owned by that attempt: process start for async
actions, exit zero for synchronous actions. Pre-existing user holds,
holds from a later run, repeated failure and cancellation remain held. Explicit
queue resume/send-now clears preparation hold ownership; failure still gates
admission. Every preparation attempt has a unique terminal identity, checked with
the writer epoch before recording completion or releasing owned work.
The admitted run records the captured provider. Session resume and session writes
require exact provider ownership, including named instances of the same driver.
A retry across providers starts a fresh session with a read-only shared-conversation
snapshot from the committed log boundary, using the existing 16,000-character
handoff collector. This snapshot belongs to the run; it neither consumes nor clears
the current provider's pending handoff/session. Session-loss recovery cannot reset
another provider's state. Successful completion clears only its own handoff context.
Cancellation and setup process creation share one owner lock; cancelling first
prevents a later spawn, and cancelling a blocked synchronous turn kills its setup
process. Each cancellation and dropped wait guard checks the bound run, so an older
attempt cannot cancel a newer retry. After an async setup starts, stopping or force
stopping its model turn leaves that setup running; thread/app cleanup still owns it.

Schema 18 adds `thread_setup` with a cascading thread foreign key. Its preparation
marker and thread commit in one transaction, before clients can admit a turn.
Registration failure and early returns close that marker. Process handles stay in
Core, with no detached setup waiters. A normal shutdown preserves known completion
and records unfinished work as failed; an already-started async action remains
nonblocking. Restart fences old pending writers before admission.
Existing threads receive no marker and never execute setup retroactively. Older
cores reject the newer schema before changing persistent data; rolling back requires
a database backup from the older schema, not an older writer against the newer database.
Schema 19 adds the serialized captured setup, first prompt/attachment IDs, engine
instance and model selection, bound preparation run, per-run retry/context metadata
and per-message preparation hold owner. New thread creation captures
the effective command; first admission captures input in its admission transaction.
No command is reconstructed for schema 18 rows with a null capture. Their existing
fence remains effective, while preparation retry is unavailable. Core's data-directory
lock still permits one service writer, migrations run transactionally and old binaries
refuse newer schema versions before opening a writer. A crash during synchronous
preparation closes its bound run as a preparation failure without requeueing a
second copy of its input; restart preserves the capture and requires explicit Retry.
Epoch and terminal fences reject delayed completion from the previous process.
Only disposable fixtures qualified this migration; owner databases were not opened
or migrated. Recovery uses the current writer or an older-schema backup, never an
older binary against schema 19.
Moving or deleting a thread clears its setup and closes its old terminals/previews.

## Settings and maintenance

Animated disclosures clip their content without owning an internal scroll offset.
The settings pane owns scrolling; focus and scroll-into-view during the 200 ms
height transition must not move a control inside a hidden scroll container between
pointer positioning and activation. Fixed provenance popovers retain their own
viewport placement and scrolling.

`ServerSettings` holds lifecycle and pricing. Everything else is in a fixed catalog of
preferences, each with a default and a shape: an unknown key or a wrong shape is
`400`, and a change applies all of its values or none. A preference resolves project,
then environment, then the actual project file where supported, then default, and only those marked `project_scoped` can be set per
project. The catalog holds no secret: provider environments and tokens stay out under
rule 1. `disabled_engines` is enforced when a thread is created, and custom, hidden
and reordered models apply in `/api/engines/:id/models`.

The project settings Model control writes `default_engine`, `default_model`,
`default_effort` and `default_model_options` together as one tuple, fencing all four
preference revisions and the selected membership. Effort and option selects show the
default model's own options; choosing another model clears them, and any of the four
differing across the selection shows Mixed without a write. Automatic sets an empty
tuple; Inherit removes the selected project overrides of all four. The fallback model
is its own scoped row beside it. A conflict
retains the choice and requires an explicit reload before retrying. Reset all
removes only the captured project overrides and leaves environment defaults alone.
Its model picker stays in the owning settings dialog's top layer. Escape closes
the picker and returns focus to its trigger before another Escape closes Settings.

`POST /api/settings/project-scopes` is a full-app read of registered local checkout
groups and a typed selection. It accepts the client's `repository`, `repository_path`
or `separate` grouping recipe and per-physical-project overrides. Repository identity
uses a recognized origin before an upstream, so a fork remains its own project;
HTTPS, SSH and SCP locators drop userinfo, query and fragment before opaque hashing.
Path case and explicit ports stay distinct. Local/file or unrecognized remotes fall
back to the physical project, never its display name. Git reads have capture and time
budgets, cannot use transport or credential helpers, and never return or store a raw
remote URL. Effective local and worktree configuration uses Git’s first fetch URL;
include directives and URL rewrites remain explicitly unobserved, without opening
include files. Global/system configuration is excluded. They share the library reader guard until their children finish.

The harness library is excluded from selectable targets and recipe overrides; missing
workspace state fails instead of broadening scope. Registration retains the canonical
selected physical folder, including a repository subfolder, as its identity and local
cwd/configuration root. Duplicate Add requests are rejected for that exact folder;
CLI activation reuses an exact registration. Trust is independent of a registered
parent or sibling. Git identity and repository-relative
paths are separate catalog observations. Existing root registrations keep their
identity; registering a child does not rewrite them. A missing checkout remains
unavailable. Failed or unobserved metadata is explicit and prevents resolving a logical
repository group whose membership may be incomplete; completed physical fallbacks do
not. An explicit checkout target is shown with that checkout’s project name. Its parent
logical group is not marked selected in the picker; switching to the group requires
choosing it explicitly. Unknown or stale selections never widen to All projects. An absent selection or
explicit All projects means environment defaults, not a project-override fan-out.

New worktrees use the primary clone’s fixed sibling `<repo>-wt/<purpose>` root,
including requests from a selected child or another linked worktree. A local thread
uses its selected folder; a worktree thread uses the whole new worktree root for
files, configuration, scripts and engine cwd. Git status and review diffs use the
whole repository and repository-relative paths. Checkpoint capture and restore stay
within the selected subtree, including tracked files in an ignored selected folder;
restoring a child leaves sibling changes and untracked files untouched.

`POST /api/threads/:id/paths/resolve` maps a reference with an explicit thread or
repository coordinate basis and expected cwd into optional checkout and repository
paths. It returns no file content. Thread links prefer an existing safe file after
stripping the longest repeated workspace suffix, then try the literal thread path.
Only existing safe files inside cwd receive a checkout path; missing tracked files
and sibling Git patches may retain repository coordinates for diff navigation.
Ordinary file reads/writes and engine scope remain bounded to thread cwd. File and
diff reveal intents are transient, capture thread/cwd before resolution, and consume
only their own nonce. Route/cwd changes and newer navigation invalidate stale
responses, including when an older request completes last.

`POST /api/settings/preferences/query` resolves environment, logical-project or
physical-checkout rows from one SQLite read snapshot. Effective values that differ
are Mixed; equal explicit overrides keep their source and remain resettable. All
projects edits environment defaults and lists explicit overrides without copying a
value to every project. Project-group edits target only its registered members.

`PUT /api/settings/preferences` requires the observed membership version and one
revision per edited key. Set, Inherit and Reset overrides are distinct operations;
Set null means Never for nullable lifecycle settings, while Inherit deletes the
selected override. Object Set values are top-level field patches merged independently
with each target's transaction-current effective object; unmentioned fields survive. Reset overrides carries explicit physical IDs and preserves the
environment value. All affected global, lifecycle and project writes commit in one
immediate SQLite transaction or none, preserving unrelated and unknown settings.
Missing or changed scopes and stale revisions return typed 409 errors, never a
broader write. Group and checkout edits share the same selected-member metadata
rule: incomplete repository metadata disables either selection unless its physical
member is explicitly grouped Separately. These full-app routes do not add engine tool capabilities.

Git and project-file observations precede SQLite. The immediate transaction fences
registered IDs and paths, the observed catalog membership version, and each key's
effective value and override presence. External Git/file changes after observation
cannot share SQLite's atomic lock; no claim is made that those external files are
transactional. Metadata uncertainty never broadens the selected member IDs. Query
keys, values and response size are bounded. Runtime streaming, restart recovery,
title generation, merge settling and idle settling use the same project resolver.
`/api/info` supplies
the local host display name for the fixed local environment label; it performs no
remote lookup and adds no selectable remote environment.
The local UI preserves project/checkout IDs across settings sections and exact-row
search. Device-only sections (General, Appearance, Chat, Diffs, About) intentionally
edit this computer's defaults, so a preference a project may override is never bound
only there: its row lives on a project-scoped section. Default permissions, response
streaming, agent browser access and continuing threads after a restart are on Threads
for that reason. Preference
rows and thread lifecycle/title controls use scoped reads and revision-fenced edits;
Mixed controls do not save an untouched empty value. Provenance displays actual
project, environment, file and default layers. Reset all deletes only the explicit
listed project overrides. Each write stays attached to the scope that supplied its
revision, including when navigation changes before it finishes. On Providers,
`disabled_engines` is bound to the selected scope (Providers in use), and the service
refuses a new thread on a provider its project turned off. Provider instances and
custom models are environment settings: they apply to every project, the page says
so when a project is selected, and their writes always target the environment.
Native walkthroughs remain to be verified before the parity claims are complete.

Project images are passive metadata, resolved by registered physical project ID.
`GET /api/projects/:id/icon/resource` returns the source, relative path, content
revision, closed media type and size without embedding bytes. The fixed
`icon/raw` and `images/raw?path=` routes stream the resolved image or a checked
picker candidate. They create no thread, execution permission or ordinary file
grant. Untrusted projects may supply local images; scratch and library roots are
refused. Structured overrides take display priority. A stored relative image hint
precedes project-file hints, ordered automatic candidates and supported local
source hints. No website is fetched or source executed. SVG is used only as an
image, never injected as markup.

The legacy `GET /api/projects/:id/icon` JSON reader retains its 1 MiB image limit.
Resource/raw reads use the existing 1 GiB raw-file envelope and hash selected bytes
in bounded chunks, checking handle identity, size and modification time afterward.
Config/source text stays bounded to 256 KiB per file and 2 MiB aggregate. Actual
opened handles must stay inside the selected canonical root and outside Git/library
paths before and after reading. Fixed metadata paths require an exact relative
match. MIME follows the checked handle's image filename; ICNS exposes only a checked
embedded PNG extent. Raw range offsets are relative to that extent, not the container.
Raw images retain conditional/range handling, sandbox/nosniff and private cache
headers. Query tokens authorize only GET/HEAD on exact image raw routes; metadata,
search and writes still require ordinary authenticated requests. Native CORS remains
limited to the existing exact native origins.

Badge loading waits for the known workspace-library path and excludes scratch and
library identities. Retained workspace metadata remains usable during polling;
a changed library identity hides its previous image immediately. The shared memory
cache keys service origin, physical ID, registered path and saved hint, deduplicates
reads and bounds observations/encoded bytes to 128/8 MiB. Hits expire after ten
minutes; misses, errors and decode failures retry after one minute. Optional reads
have a 30-second deadline and observation fences prevent late publication despite
ignored aborts. A single unmount cannot cancel another badge's read. Reconnect or
metadata changes retry while retaining a previous preview; removal purges that
project. Routine four-second project polling does not bypass cache lifetimes.

An optional IndexedDB store retains at most 128 previews and 1 MiB of data URLs,
each at most 32 KiB, keyed by stable client origin, physical ID, root and saved hint.
It stores content revisions and no service URL, token or volatile service port.
Matching revisions reuse previews even when the resource reply arrives before
the bounded persisted read; cancellation and observation identity are rechecked
after restoration before fetching image bytes. Authoritative missing/refused resources and
image decode failures remove them. Transient read failures retain the previous
preview. Clear/delete/project-purge generations fence pending storage operations.
Storage failure leaves raw image delivery available. Preview reads stop at 4 MiB,
validate the content ETag and retain small data URLs; larger bitmaps try 96 then
48 pixel WebP at 85 percent quality and release their decoded bitmap. Large SVGs
are not rasterized. Uncacheable images use the fixed authenticated raw route with
a content-version query. Badges retain the last decoded image while a replacement
loads. Images never enter project lists or persisted UI state.

Automatic fallback identity uses the normalized display name alone: Unicode
letter/number words choose the first letter and a first-word digit, otherwise the
last word's first letter or the first word's last letter; uppercasing keeps two
code points. A normalized en-US lowercase polynomial selects the reference's 18
named colors. The shared project badge owns this behavior without changing
unrelated monogram helpers.

Project Icon edits use the same selected physical-member fence as Name, with an
observed membership version and exact decimal-string metadata revision per member.
All comparisons precede writes in one immediate transaction; a stale member rejects
the entire group. A set or explicit-null Reset changes only the structured icon,
clears its saved image path and advances the revision. Missing `icon` is invalid.
Known icon kinds are Lucide name plus one of 18 colors, emoji text, and monogram
text plus color. Core applies JavaScript trim and UTF-16 limits, preserves direct
API case/normalization, and limits command monograms to two extended graphemes
with Unicode letter/number/mark/joiner rules. Unknown stored future kinds use the
automatic display fallback; malformed known stored values fail explicitly.

The picker freezes membership, physical IDs and revisions when opened. Cancel
has no write. A conflict retains the draft and requires explicit reload before
another save; a late response cannot replace a different selection's dialog.
Committed rows update the workspace separately from subsequent catalog-read errors.
A committed project edit or removal supersedes older project-list reads and ends
their loading state; a delayed poll cannot restore stale metadata or a removed row.
Committed mutation replies also compare canonical decimal revisions as exact
integers; a lower or absent revision cannot replace an observed versioned row.
The comparison precedes claiming the project-list generation, so an old mutation
cannot cancel a newer read. Project icon presentation also compares valid
canonical i64 revisions across catalog, locally committed and workspace observations,
using only the same physical ID and exact registered root. A stale committed overlay
or failed catalog refresh cannot hide a newer known icon. This display comparison
does not rebase a dialog's frozen membership/revisions or re-enable failed reads.
The picker normalizes monogram input with NFKC and uppercasing; the renderer keeps
received text unchanged. Package-owned Lucide loaders have a bounded component
lifetime and unknown names use FolderCode.

Choose file opens the same command-style local image search in web and desktop.
An open freezes selection, representative physical root, membership and expected
revisions. Search accepts empty queries, hides old entries immediately and fences
query generations, including an A-to-B-to-A round trip. Only visible candidates
load fixed-route thumbnails; failed decoding leaves the file glyph. Keyboard,
IME, Escape and backdrop behavior do not write until a candidate is selected.
Selection closes the picker before posting the relative POSIX hint to every
selected physical member. Missing peer files or a source removed after selection
do not prevent saving the hint; each member resolves its own bytes or fallback.
The image writer clears the structured override and advances metadata revisions;
structured writes and Reset clear the hint. A conflict refreshes the catalog for
a later explicit open and never replays the write. No project files are copied or
changed.

In the desktop app, Choose from computer opens the shell's native file dialog for an
image outside the project. The web asks the service, which sends the shell one
`choose_project_image` request and holds the call open; the shell returns only the
chosen path, or none, and only one dialog is open at a time. The caller never names a
path, and a remote viewer cannot open the dialog. The service accepts an absolute
regular file of at most 8 MiB whose extension is a project image type and whose
leading bytes are that kind of image (an SVG must be text with an `<svg` element), and
keeps only the PNG inside an ICNS file. PNGs, including extracted ICNS PNGs, must
fully decode before publication, with at most 8192 pixels on either axis and a
64 MiB decoder allocation budget; truncated or oversized decoded images leave the
existing project icon and metadata revision unchanged and create no managed copy.
Other formats retain their existing identification checks. It copies the bytes into
`<data>/project-images/<sha256>.<ext>`, so the same image is one copy and the original
may move or go. The project records the copy as `./.orbyn-imported/<sha256>.<ext>` in
`favicon_path`, through the same membership and revision fences as a project image. A
checkout hint can never take that form, because hints have no `.` component; reads
open only the copy, never the original, and refuse a link in place of a copy. The
reserved form joins no image-search history. A cancelled dialog is `204` and writes
nothing; on a plain server the request fails because there is no desktop app.

Core search runs no Git command or hook and reads no global ignore configuration.
It parses checked in-root `.gitignore` and `.ignore` data, never descends symlink
directories, validates candidate handles without hashing each image, and bounds
visits/depth/enumeration time to 20,000/48/3 seconds with a separate cooperative
3-second scoring budget. Bad ignore lines keep valid rules and mark truncation;
unreadable or unsafe ignore sources omit their subtree. Results are capped at 200.
Independent case-insensitive Unicode subsequence matching ranks basename, prefix,
contiguous match, gaps, position and path length, then recent selection/count/path.
Empty queries prioritize selection history. This ordering is the product rule: a
lexicographic comparison of more words matching the basename, more word prefixes,
more contiguous words, fewer gap characters, earlier match positions and a shorter
path, then the most recent and most chosen history, then the path. It has no numeric
weights and does not reproduce the reference app's `fff` scoring, whose weights
Orbyn neither copies nor matches.

Schema 21 adds nullable `project_icon` JSON and `favicon_path`, and a nonnegative
integer `metadata_revision` initially zero; wire revisions are decimal strings.
Existing rows and unrelated columns remain intact. Schema 22 adds per-project/path
image-selection history with a cascading foreign key, saturating selection count,
nonnegative last-use timestamp and 256-entry per-project bound. Image transactions
record history only after all comparisons; Reset/structured changes retain it.
Selected and legacy Name, icon/image, scratch adoption and false-to-true trust
writers advance the shared revision using partial-column updates. Repeated trust
leaves the row revision unchanged; audit and trust remain one transaction. The
existing exclusive data-directory service lock serializes old/new live writers.
Schema-20 and schema-21 binaries must refuse a schema-22 database before WAL setup
or migration, and cannot bypass a live current owner. Recovery requires the current
writer or a complete pre-upgrade backup; never lower the schema marker or run an
old writer on it.

Project Name edits require an explicit group or checkout, its observed catalog
version and the raw expected name of every selected physical member. Core matches
JavaScript trim whitespace and rejects an empty result without a title-specific
length limit. Aggregate rename fan-out/serialized response is bounded to 4 MiB,
independently of the 512-target and transport-body limits. A dedicated immediate transaction rechecks all registered physical
IDs/paths and every expected name before updating the name and advancing the shared metadata revision. Any conflict rejects
the entire group. Trust, folders, project files and other metadata are unchanged.
The response contains committed rows from that transaction; subsequent catalog
refresh is a separate read. Single-member groups display the physical title;
checkout-selected Name retains the original logical group label. Registered Checkouts are listed from catalog members, never the Git worktree
inventory. Removal counts current and archived threads, freezes the confirmed
physical IDs and deletes only entries through the existing file-preserving route.
Cancel sends no delete. Core remembers the exact IDs returned by each successful
thread-family deletion, skips those rows later in the project list and performs
setup/terminal cleanup once per deleted ID. Busy and unexpected errors still
propagate. Partial failure retains the failed member and prior
successes; explicit retry skips successes. Whole-group selection clears only after
a fresh catalog confirms its absence. A read failure after committed deletion is
a separate refresh failure. All projects
shows the reference's choose-project notice. Unavailable selections cannot rename
another target; a stale save retains its draft without automatic replay.

Custom models belong to the local environment even while a valid project or checkout
is selected. Their editor queries that explicit environment target and saves the raw
list with its observed membership version and row revision. A conflicting edit
refreshes both reads without clearing the person's draft or replacing newer models.
Other engines' entries, unknown records and forward fields are preserved. Loading,
unavailable selections and unsupported list shapes cannot submit a mutation. Once
the preference commits, refreshing model discovery is a separate read and cannot
turn that saved model into an apparently failed Add.

OpenTelemetry export is an environment-only form. Project, checkout and unavailable
selections show the reference's environment choice instead of editable global fields.
The fixed local environment maps to All projects defaults; selecting it is explicit.
The form reads an observability snapshot and saves only touched endpoint fields with
the observed membership version and row revision. Save and Discard own controlled
drafts; blur never writes. A conflict refreshes the read, keeps drafts and requires
another explicit Save. Restoring a field removes its draft so a later save cannot
resend an old value over another client's change. The Core object-patch writer
preserves unmentioned and unknown telemetry fields. Scope changes dispose the form's
response owner; a late save cannot clear a new draft or update a different scope.
Endpoint test results stay attached to their requested URL and generation. These
bindings qualify local settings behavior, not native parity.

`orbynd` reads the saved `observability` endpoints once at startup, so an edit applies
on the next start. With a logs URL the service sends warnings and errors as OTLP/HTTP
JSON logs; with a metrics URL it sends each new memory and process sample as gauges.
A URL that is not absolute http or https is ignored. Nothing is queued for an unset
signal, the log queue holds 256 records and drops the oldest, a refused or unreachable
batch is kept for the next pass within that limit, redirects are not followed, and a
final bounded flush runs at shutdown. The exporter's own events never re-enter it.
Traces have no producer because the service records no spans; that URL is only
checked. `ORBYN_TELEMETRY_INTERVAL_MS` overrides the 15 second cadence for tests.
The exporter is listed with the other automatic requests.

Automatic known-provider discovery defaults to all installed known CLIs. The
internal `EngineConfig.known_engine_ids` can restrict that enumeration; absent means
all, an explicit empty list means none. It leaves registered custom providers,
explicit instances and direct known-provider lookup unchanged and is not an access
rule. Service bootstrap accepts this optional list as UTF-8 JSON in
`ORBYN_KNOWN_ENGINE_IDS`; malformed input fails startup without logging its value.
Disposable browser fixtures choose an empty discovery domain and pass only selected
runtime environment variables, with private home, XDG and Windows app-data paths.
Controlled providers opt into production discovery to verify catalog shutdown;
ordinary fixtures cannot accidentally probe providers installed on the host.
Cleanup failures remain failures with the same retry budget.

`provider_instances` holds named setups of an engine, each its own engine to threads,
with its own models and sessions, so changing a thread's instance is an engine switch. An
instance has an id, a `driver`, and optionally a name, an accent, `enabled` and a `program`
that replaces the driver's. ACP, AG-UI and terminal instances also take `args`, added after
the driver's. Claude and Codex take a program only, because a flag can switch off the gate.
A Claude instance may also set `auto_compact_window` (100000 to 1000000 tokens, or empty), which each
run passes to the CLI in its private `--settings` file beside fast mode. It is refused elsewhere.
The internal `_local_acp` driver kind takes a required executable and literal arguments
directly in that one instance record, without creating or displaying a base custom engine.
A pre-existing custom engine with that ID keeps its old launch behavior and prevents
new command-only instance edits from silently reinterpreting it.
A turned-off instance is not listed and refuses new runs, and threads keep their history.
An instance of Claude is still Claude to the permission prompt, rules, version checks and
custom commands. Nothing here holds an account: no environment, no config folder, so a
second login stays out under rule 1. The list is global, so no tool can reach it.
Changing the list clears model catalogs and selection validation, so a changed setup
cannot keep the former driver's offered options. Since instances can share a binary,
an engine update refuses while any run is active, and no run starts during an update.

An engine update runs only the installer that provably owns the binary, from its resolved
path and that installer's own answer: Homebrew, npm, pnpm, Yarn, Bun, Volta (its package
image must hold the engine), Vite+ and winget, or the engine's own updater. Anything else,
including a mise install, stays manual instructions.

An ACP instance can manage the sessions its agent keeps. Capabilities come from the
agent's `initialize` reply alone: `session/list`, `loadSession`, `session/resume` and
`session/delete` are each offered or not, and nothing signs in or prompts. Every
operation is one short process owned by its future, started in a throwaway directory, with
a four-megabyte and 4096-message budget, a sixty-second deadline, and client requests
denied. The service, not the caller, chooses the folder: listing, import and delete take a
registered, trusted project, and only act on a session the agent lists for that project
(up to twenty pages). Folders an agent reports are data, never access. Import replays the
history without a run, then stores the thread, its events and the session id together; a
second import returns the same thread. Delete refuses while any thread holds the session.
One operation runs per instance: it excludes that instance's run admission, updates and
edits to `provider_instances`. A later run resumes with `session/resume` when offered,
else `session/load` with its replay discarded; an unknown session ends the run as a lost
session. The session link is the thread's engine session, so no table or migration exists.

A new worktree uses `branch_name_prefix`, `base_branch` or the origin's head when
`new_worktrees_start_from_origin` is on, falling back to HEAD, and
`worktree_submodules` through the shared preference resolver. Checkout mode and
submodule behavior resolve Project override → Environment override → the actual
`orbyn.json` (or fallback `t3.json`) → built-in default. Explicit equal-valued
overrides remain overrides; resetting removes them without changing project files.
Invalid file settings reject the whole file rather than partially applying it.
Submodule values are `recursive`, `top-level` and `none`. They initialize nested
modules, direct modules only, or no modules, respectively. Earlier `top_level` and
`skip` spellings remain accepted and normalize on read without rewriting stored
settings or project files; UI edits use the canonical values.
A new draft waits for the selected checkout's effective mode; explicit checkout
choices and reused worktrees win, and late responses cannot change another project.
A folder outside Git shows "This folder" and offers no checkout choice.
A new worktree without an entered purpose gets a unique prompt-derived purpose. `auto_pull` fast-forwards
a clean checkout on the remote's default branch every 30 minutes.

`keybindings.json` lives in app data and holds only the person's changes over built-in
defaults, so new defaults reach them. `mod+w` is reserved: in the desktop app the page
takes it even when no rule runs, so it never closes the window. A browser closes the tab
before the page hears it, so outside the desktop app a `mod+w` rule also matches the same
key with `alt` in place of `mod`; the editor says which applies. It allows comments and trailing commas, and a
bad entry is reported while the rest apply. A key with two commands in one exact
context is a conflict; a key in two contexts is not.

The Worktrees Cleanup form edits the new policy through scoped membership and
row revisions. Project and checkout selections expose Inherit, Off and Custom;
Mixed modes require an explicit choice. Project rules display only for Custom;
the settled-age rule accepts zero and uses an independent on/off switch. Environment edits keep
project overrides. Numeric conflicts refresh saved policy while preserving the
person's draft for explicit retry, and late responses stay with their original
scope. Unsupported cleanup rules are not exposed; inactive, merged, deleted and
unchanged-worktree cleanup and automatic scheduling remain unimplemented.

The Maintenance artifacts/log retention controls and Delete now action are visible
only for the local environment. Their scoped snapshot supplies the membership and
preference revision for each single-field update: enabling a rule stores eight days,
disabling stores null, and numeric drafts commit on blur or Enter. A conflicting
write refreshes the snapshot while retaining the draft for an explicit retry; it
never replays the edit. Scope disposal fences late writes and reports. Unmentioned
fields, including legacy project cleanup objects, remain untouched. Maintenance has
no worktree-age control or Preview action; the dry-run API and `GET
/api/storage/cleanup/preview` (counts and sizes, which Delete now and Delete settled
worktrees share, since both run the one cleanup) remain available. Delete now invokes the existing environment cleanup operation, and
Last run reports its actual removed/kept entries. Action eligibility also reads the
distinct worktree policy: explicit environment Off suppresses legacy defaults,
empty environment policy retains a valid global age including zero, and project
Custom ages can independently enable cleanup. Legacy project storage cleanup
objects never enable it. The project policy and its runtime retain their own owner.

Worktree retention uses the separate project-scoped `worktree_cleanup` preference.
Its default `{}` inherits: an empty project object first uses the new environment
policy, and an empty environment object falls back only to global
`storage_cleanup.worktree_settled_after_days`. Legacy project `storage_cleanup`
rows remain stored and never activate worktree cleanup. `mode: "off"` disables it;
`mode: "custom"` uses `rules.settled_after_days`, an integer from 0 through 3650 or
null. Zero is immediate; absent/null custom age is Off, not an inherited age.
Inherit deletes the new project override. Scoped rules patches merge per physical
member, preserving unknown top-level and rule fields. Selecting Custom without an
explicit age captures each member's transaction-current effective age: inherited
legacy/environment rules stay active, existing Custom stays unchanged, and Off
captures null even if an inactive age remains stored. Mixed members never copy the
first member's age. Runtime cleanup and this transition share the same resolver.
Known invalid policy shapes
are rejected, and corrupt stored policies stop the pass before any effects.

A cleanup pass takes exclusive policy admission before resolving all projects and
holds it through the pass. New-policy writes and global legacy retention writes
try shared admission around their settings transaction; an admitted or queued
cleanup returns the existing settings conflict instead of accepting a policy edit
against that pass. Manual passes serialize. Membership and row revisions still
fence scoped edits; they do not themselves fence filesystem effects. Before each
worktree removal, the live-owner check scans all projects, including selected
subfolders inside that worktree. Concurrent thread creation after this check remains
an existing unfenced boundary; no concurrent thread-creation guarantee is claimed.

Schema 20 is a semantic writer fence with no row conversion or deletion. The app's
data-directory owner lock excludes another running service; once it releases,
schema 19 refuses version 20 before WAL setup or migration rather than ignoring
project Off. Current version 20 writers retain the existing scoped transaction and
revision checks. Recovery uses the current writer or a pre-upgrade backup; never
lower the schema marker or reopen this database with an older cleanup writer.

Storage cleanup removes logs, browser artifacts and worktrees settled past their
retention. A worktree goes only through `git worktree remove` with no force, so Git
keeps uncommitted work. Candidates observed as owned by another live thread are
kept. `?dry_run=true` only reports. Database repair is a `VACUUM`, refused during a run, and suggested at
1 GiB reclaimable. The OTLP check posts an empty export and reports the status.

## Environment identity

The local environment publishes a theme in `GET /api/info` as `environment_theme`:
the `default_theme` preference and `default_theme_set_at`, the Unix milliseconds when
it was last written. Every write of `default_theme`, from settings or `orbyn theme`,
stamps that time, and clearing the theme clears it; a client cannot write the time.
A theme is `system`, `light`, `dark` or a theme id. Each viewer applies a published
theme once, when its `set_at` is newer than the one it last applied, at startup and
when the window takes focus; after that the viewer's own choice stays. An unknown id
is recorded as applied and changes nothing. A theme saved before set times existed is
published with `set_at` 1, so each viewer applies it once. Remote environments publish nothing here.

`/api/info` also names the build's `channel`: `dev` for a debug build, `nightly` or
`stable` from `ORBYN_CHANNEL` at compile time, and `stable` otherwise. The sidebar
marks it as the viewer chose: Dev or Nightly artwork (nothing for stable), a version
pill, or none. That choice is viewer-local.

Appearance edits `default_theme` and `environment_icon` as environment settings through
the scoped preference writer, showing when the theme was set. `environment_icon` is one
of `laptop`, `desktop`, `tower` or `server`, or empty for the plain monitor; `/api/info`
publishes it and the settings environment label draws it.

## Agent history import

`GET /api/history/sessions` lists Claude and Codex conversations from the engines' own
history folders (`CLAUDE_CONFIG_DIR` or `~/.claude/projects`, `CODEX_HOME` or
`~/.codex/sessions`), newest first. It runs only when a person asks. It reads at most
400 files per engine, 4000 folders, and the first 64 KiB and 200 lines of each file,
keeping only the session id, folder and first prompt (120 characters); it follows no
symlink, writes nothing there and reads no other file. A session whose id is not a
plain word or whose folder is not absolute is skipped. Each session names the registered
project at exactly its folder and whether that project is trusted.

`POST /api/history/import` takes only an engine and a session id; the service rescans
and finds the file itself. It needs the session's project registered and trusted and
the engine enabled there, then creates a thread whose engine session is that id, with
no copied messages, so the next run resumes the engine's own conversation. A second
import returns the same thread. Claude's `subagents` folders and `isSidechain`
transcripts are skipped, and a session listed by several files appears once, from its
newest file. A session whose folder is not a project offers Add folder, which registers
it untrusted through the ordinary add path; trusting it is the ordinary trust page. Pi is not an engine Orbyn runs, so its history is not
scanned.

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

`GET /api/network` and `crates/orbyn-core/src/governance/network.rs` list every outbound request
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

Every firing is noted in the task's run history, newest first and bounded to the last
50: when it started, its source (`schedule`, `manual`, `webhook` or `after_thread`), the
thread it works in and an outcome. A firing that could not start is `refused` with the
reason; one put off by `task_skip_near_limit` is `skipped`; a started one is `queued`,
`running` or the end state of the first run its thread began since, read when listed, so
it is as current as the thread. `task_skip_near_limit` (off by default) makes a firing
from the clock, not a manual or webhook one, wait for the next time when the task's
engine reports a limit window at 90% or more; an engine that reports nothing never
holds a task back.

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

The source viewer offers comments on one line or a Shift-selected range. Comments
capture at most 4,000 source characters and 20,000 comment characters, within the
complete prompt limit. Their annotation positions belong to the displayed revision
and checkout; a reload or edited revision never transfers those positions to new
source. Submitted chips keep their captured context when the file changes, and
only the ordinary send action passes that context to the engine.

Diff comments are the same review chips. A new-side line in the stacked or split
diff takes a comment on one line or a Shift-selected range, with the shown added and
unchanged lines as the excerpt and the same limits. The comment shows under the
range's last line for as long as its chip exists, only in the diff view it was made
on (source, run, base or commit, and checkout); editing or removing the chip edits or
removes the annotation, and the annotation's Remove removes the chip. Removed lines
take no comment, since a chip names new-side lines only.

A large diff mounts its files a page at a time: 50 files or about 4,000 patch
lines, never less than one file. The next page loads as the end of the list
scrolls into view, or from its Load more button. The file count and line totals
cover the whole diff; Find counts matches in loaded files only and says so while
files remain. Revealing a file loads the pages up to it first. The service still
returns the whole diff in one response.

`GET .../files/raw` serves bytes from that same checked handle, up to 1 GiB, with one
byte range at a time; a form it does not serve gets the whole file. A checkout holds
code nobody here wrote, so nothing in it may run in this origin. The type comes from
the name, never the bytes: images, audio, video, fonts and PDF are `inline` and
everything else is `application/octet-stream` as an attachment. All of it is `nosniff`
and sandboxed by CSP, which is what makes SVG safe, except PDF, which browsers will not
show sandboxed. An image or video element cannot set a header, so this route takes
`?token=` as the streams do, with `no-referrer` to keep it out of anything a file links
to.

### Files outside the checkout

A person can open one file outside the thread's checkout to read it: a full-path link
in a message, or a full path typed into Files. `GET .../files/outside?path=` takes only
a full path, Core canonicalizes it with links resolved and then decides; `orbynd` only
routes and the web holds no rule. It refuses the thread's own checkout (those files keep
the checkout routes and their rules), Orbyn's data folder (the service token and every
thread's records), a path on another machine (on Windows a UNC, `\\?\UNC\` or device
path; on macOS the `/net` and `/Network` automounts) and a local link to one. Before canonicalizing,
Core resolves the path itself one part at a time, `..` stepping back from the folder
actually reached and every link read, not followed, and judges each folder before it
looks at it, so no host is contacted:
on Windows that contact would send the person's credentials. Path resolution for message
links applies the same check. The file is opened without following a final link, the
path its handle names is checked again with `\\?\` and plain drives compared as one, and
a file with more than one name is refused because a second name can hide where it lives.
A folder is refused, never listed. Reads run off the service's runtime and give up after
15 seconds. The cap is the checkout read's
4 MiB; past it the size is reported without bytes. The answer has no revision and says
`outside: true, read_only: true`; there is no write, rename, delete or listing route for
these paths, and the viewer offers no edit, save, download, editor launch or composer
attachment. The thread's folder must be trusted like any file route; the file's own folder needs no
trust, because a person reading a file runs nothing in it. This is a person's view,
not a tool: no engine, MCP tool or agent route reaches it. HTML from outside renders only
in a `sandbox=""` frame (no scripts, no same origin, no forms or top navigation) whose
document starts with a `default-src 'none'` CSP, so it cannot reach the app, its token,
the API or the network.

## Renders

An agent's page is stored in app data, never in the checkout:
`<data_dir>/renders/<thread_id>/<render_id>/index.html`, with one `image-<n>.<ext>` beside
it for each checkout picture the page named and `frame.sha256`, the digest of that
render's frame token. One folder per render is the whole record — no database row — so the
folder is removed with its thread and the cap is counted from the folders that are there. A
thread keeps 20 renders, and the oldest folder goes when a newer one is published.

`POST /api/threads/:id/renders` takes `html` and answers with the render id, its route, its
`frame_token`, the number of images copied and the stored size. A page over 512 KiB is
refused whole. Each `<img src>` is resolved with the same read rules every file route uses,
so a path outside the checkout, a link out, `..`, `.git` or an untrusted folder is refused
per image: that src is left exactly as written and the rest of the page still publishes. A
picture over 8 MiB, or the 33rd one, is left as written too. A remote http(s) src is never
fetched and is left as written; the policy below is what stops it loading. The scan matches
the tag and the attribute name case-insensitively, in any attribute order, with single,
double or unquoted values, and ignores `<script>`, `<style>` and comments. It is not an
HTML parser: it does not decode character references, and markup built by script is not
seen.

`GET /api/threads/:id/renders/:render_id` serves that page as `text/html; charset=utf-8`
with `default-src 'none'; script-src 'unsafe-inline'; img-src 'self' data:; style-src
'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors
'self'`, and every render response also carries `nosniff`,
`Cross-Origin-Resource-Policy: same-origin`, `no-referrer` and `private, no-cache`.
`.../:render_id/:file` serves only `image-<n>.<ext>`, typed from its extension; any other
name, a separator in it, `frame.sha256` or another thread's render id is not found.

A frame runs the page's own script, so the credential in its URL must not be the service
token. Each publish therefore mints a frame token with `random_token`, stores only its
sha256 in `frame.sha256` before the page is written, and returns it once; the two read
routes accept `?render=<frame token>`. The access middleware decides: the request must be
`GET` or `HEAD` on exactly the page route or the image route of one render, and core must
find that render and find that its stored digest matches. A wrong token, another render,
another thread, another route, `POST` with `render=` and a render that was never published
are all refused, so a page script that reads or leaks its own URL holds a capability for
one render and nothing else. `?token=` with the service token still works on those routes,
and so does the remote session cookie. A published page must never reach the API: this
policy, the scoped frame token and the web frame's `sandbox` attribute (C21) are what stop
it, and `allow-same-origin` belongs in neither. `script-src 'unsafe-inline'` is what lets an
agent's page draw a chart, and it is only safe because the frame is `sandbox="allow-scripts"`
without `allow-same-origin`: the page gets an opaque origin with no storage, no cookie and
no API of this origin, there is no `connect-src`, so it has no network, and no external
script may be loaded either.

The timeline shows a published page as a card: the title, the page in a frame of the height
the call asked for, and an Open control. The frame is `sandbox="allow-scripts"`,
`referrerPolicy="no-referrer"`, and `color-scheme` from the app's current appearance. The
frame's `src` is built on the client from the thread, the render id and the frame token
(`/api/threads/<thread>/renders/<id>?render=<frame token>`) and never from a `token=`. The
expanded view is a dialog with a zoom control from 50% to 200%: the frame is laid out at
1/zoom and scaled back, so the card's height stays the height on screen. Nothing measures
the page, so the height is the height the call asked for, or 480.

C23 verifies the render surface in the real-service Playwright suite using the
headless shell already installed for E2E. A published canvas is captured inside the
same sandbox at 320 by 240 CSS pixels. The captured PNG is decoded to check its
dimensions and known background and shape colours, with no console or page errors.
The PNG is attached to the test result. This adds no browser download or runtime
verification API; automatic page measurement remains unimplemented.

## MCP Apps

An MCP App is a page an MCP server names on a tool's descriptor with a `ui://` resource.
Codex is the only engine that reports one. Codex 0.166.0, observed on 6 November 2026 with
a local server whose tool carried `_meta.ui.resourceUri`, finished the `mcpToolCall` item
with `mcpAppResourceUri` set and `mcpAppUi` null; newer descriptors fill `mcpAppUi`, which
wins when present. While the run's app-server is still alive, the driver asks it for
`mcpServer/resource/read` with the server, the URI, the session and the call id, for at
most 10 seconds, and takes the first HTML text content for that URI; a blob page is not
decoded. Only a completed call has an app. The page is stored with the render store under
the same limits, but nothing is embedded: its HTML comes from an outside server, so no
checkout image is copied in and every `src` stays as written. A `CUSTOM mcp_app` event then
ties the tool row to the render with its frame token, the server, the tool, the URI, the
preferred display mode, `prefersBorder` and the call's structured output when it is at most
32 KiB. A read that fails, times out or is refused by the render store leaves an ordinary
tool row.

The page is untrusted and gets nothing a published page does not: the C21 frame
(`sandbox="allow-scripts"`, opaque origin, `no-referrer`), the render policy with no
`connect-src`, and only its own `?render=` token. A server's requested CSP domains and
permissions are not honoured, so an app that loads remote scripts or data does not work
here. The host takes `postMessage` JSON-RPC only from that frame's window and answers only
to it. It answers `ui/initialize` with the theme and display mode, sends the call's
arguments and result as `tool-input` and `tool-result` after `ui/notifications/initialized`,
holds `size-changed` heights to 80..2000, and refuses every request it does not serve.

A page may ask for a tool call (`tools/call`) or a message (`ui/message`, user-role text
only). Each waits for the person in a host dialog outside the frame, which the page cannot
reach or click, and names the server and what it asked. The web then calls
`POST /api/threads/:id/mcp-apps/:render_id/tool-call` or `.../message` with
`confirmed: true`. Those routes need the service token; the page only ever holds its frame
token, which opens nothing but its own page. The service finds the app's server in the
render's own record, which only an app render has, and checks the policy rules as a `tool`
action on `mcp_app:<server>:<tool>` or `mcp_app:<server>:message`: a deny rule refuses even
a confirmed request, an allow rule passes without one, and otherwise an unconfirmed request
is refused. The decision is audited before the effect. There is no run to pause for a page
shown after its run, so this is the person's answer rather than an approval card, as the
computer gateway does for a call with no run. A tool call reaches only the app's own server:
Codex 0.166.0 answers `mcpServer/tool/call` only for a thread it has loaded, so the service
starts a short-lived app-server in the thread's trusted checkout, opens an ephemeral
read-only thread there and calls the tool, with no model turn and the thread's own session
untouched. Arguments are one object of at most 64 KiB, the whole call has 45 seconds, the
result is audited and held to 256 KiB. A message is queued as the person's own next message.
`ui/request-display-mode` switches between the inline card and full screen, which keeps the
same frame so the page keeps its state; Escape or the card's control returns it inline, and
the page hears the mode through `host-context-changed`.

`ui/update-model-context` leaves a note for the model: its text blocks, then its structured
content as JSON, at most 8000 characters. The web sends it with
`PUT /api/threads/:id/mcp-apps/:render_id/context`; the latest note replaces any earlier
one, empty text clears it, and a deny rule on `mcp_app:<server>:context` refuses it. Codex
has no request for model context, so the service keeps the note for the thread's next
ordinary turn (not `/compact` or `/goal`) and appends it to that turn's context in an
`<mcp-app-context server="…">` block that says it is the app's text, not the person's; a
closing tag inside the note is broken; Codex takes it with the rest of the run's context as
the thread's `developerInstructions`. A `CUSTOM mcp_app.context` event recording the server
and text opens that turn's timeline, ahead of anything the engine reports, and the timeline
shows that the note was sent. The card
says while a note is waiting and can drop it (`DELETE /api/threads/:id/mcp-app-context`). The
note is held in memory, so a service restart forgets an unsent one. Setting a note needs no
confirmation: it changes nothing until the person's next message, which shows it was sent.

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
`engine.session_lost`, `run.force_stopped` and `permission.updated`. A run copies its
permission mode when it starts, so a mode changed while a run is starting, running or
waiting on an approval applies from the next run; the change then logs
`permission.updated` (`{mode, applies: "next_run"}`) and the web shows a toast for one
that arrives while the thread is open. The prompt is logged as a `user` text message whose id ends in
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
to start: Antigravity, Cline, Command Code, GitHub Copilot, Cursor, DeepSeek, Devin, fx, Grok
Build, Hermes, Kilo, Kimi and OpenCode. One is listed only when its program is found, and
a custom engine of the same id wins. A program that resolves into a package known to put a
different CLI under the same name is not that engine: `@vibe-kit/grok-cli` installs a `grok`
with no ACP mode. Grok is started with `--permission-mode default` and
OpenCode with `{"permission":{"*":"ask"}}`, since either can otherwise act without asking.
DeepSeek cannot ask before an edit, so it is labelled unmanaged under rule 8, and so is fx
until a run shows the mode it starts in, since its automatic mode writes without asking. The
`fx` JSON viewer from npm or Homebrew is not fx. Each keeps its
own login, and only the launch has been tested, with the fake agent under those names, except
OpenCode 2.2.5, which ran real turns through `orbynd` on macOS.

The ACP driver offers protocol version 1, the only one it speaks. An agent that answers 2
in version 1's shape (`agentInfo`, `agentCapabilities`), as some shipped agents do, runs as
version 1; a reply in version 2's own shape (`info`) is refused with a message saying so,
not misread.

The handshake tells an agent Orbyn can show a terminal sign-in (`auth.terminal`). The first
`terminal` method an agent names becomes its sign-in command: the launch command followed by
the method's arguments. The provider card shows it to copy, and a run that fails for want of a
login names it. Orbyn never runs it, never calls `authenticate` or `logout`, and offers no
`env_var` method, since that means collecting a key. A method that sets variables, or a word
a Windows or Unix shell would read differently, gives no command.

Skills come from the workspace, in place. Nothing is copied, packed or signed.

- Claude starts at the workspace root and discovers `.claude/skills` and the
  library's `AGENTS.md` natively. It has no `--plugin-dir`, and gets a per-run
  `--mcp-config`, `--permission-prompt-tool mcp__orbyn_engineering__approve` and
  `--add-dir <checkout>`. Its working directory is the library, so a relative path
  means the library, and the bootstrap tells it to use absolute paths and run
  commands from the checkout. The composer offers the same skill names the CLI
  loads: `CLAUDE_CONFIG_DIR` (or `~/.claude`) `skills`, the start folder's and the
  checkout's `.claude/skills`, and enabled plugins as `plugin:skill`. Discovery only
  reads names and descriptions for the `$` menu; the CLI still loads and runs them.
- Codex's process starts at the workspace root. `thread/start` and each `turn/start`
  use the selected checkout as `cwd`, with `sandboxPolicy.writableRoots` set to it,
  so the library stays read-only. Before the first `turn/start`, the driver awaits
  `mcpServerStatus/list`, bounded at 15 seconds: startup status updates end about a
  second before tools are usable, and a turn sent in that gap reaches a model that
  answers it cannot read the files. The Orbyn context goes in `developerInstructions`,
  not the user's message, for the same reason. Real first turns on 0.166.0 through
  `orbynd` read the file 4 of 6 times with all of this, against 0 of 5 before it and
  1 of 5 with the thread at the library. It is improved, not solved; plain
  `codex exec` read it 6 of 6. Starting at the checkout loads its `.codex`
  config as the session's own, which folder trust gates. Skills reach Codex through
  the MCP tools, because its `.agents/skills` discovery follows the turn's `cwd`.
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
Parent-stdin EOF and termination handling are registered before initial provisioning.
A cancelled startup drops its provisioning future, stops owned Git helpers and removes
its staging directory without publishing readiness or a service handle.
Owned staging removal retries transient directory-not-empty and Windows sharing,
lock or access-denied errors within a one-second deadline after child termination;
an individual filesystem call is not preempted by that deadline.
It never changes permissions; an enduring failure is logged with its path and OS error.
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
worktrees, diffs, checkpoints or forge features, except that a non-colocated
Jujutsu checkout shows its working-copy diff (Source control). This differs on purpose from the
library's `workspace.py check --in-place`, which requires a Git root. The same check
runs again before each run, because a folder can change between runs.

Clone and create are the routes that make a folder, at `<workspace>/repo/<slug>` by
default or at a chosen absolute path that holds nothing yet. A clone works in a
staging folder beside its destination. Those projects are `managed`.

Removing a project unregisters it, archives its threads and never deletes them, and
leaves the folder exactly as it was. Each kept thread carries `project_removed` and the
project's name as `removed_project_name`, so the archive can say where it came from.
The project row stays hidden, and anything that would act on it (a new thread, a task
saved or resumed, a rename, trust, per-project preferences, a pull checkout) is refused
with `project_removed`. Its scheduled tasks are paused at removal; one that is somehow
still due is refused and recorded as `refused` in its history. Archived threads still list
and read. Unarchiving such a thread is refused with
`project_removed` (409) until the folder is added again, which restores the row
untrusted and clears the label on its threads. `?delete_files=true` is refused for a folder Orbyn did not create.
For one it did, dirty or unpushed work needs `confirm`, and files go only when nothing
is dirty, unpushed, ignored or in a worktree.

Worktrees sit beside the primary clone at `<repo>-wt/<purpose>/`, wherever that repo
lives, on a neutral `feat/<purpose>` branch, and a registered worktree for a purpose
is reused. A custom worktree location is not offered or accepted by either settings
API. Earlier stored location preferences are left intact but ignored; they cannot
redirect new worktrees. Existing Git-registered worktrees remain at their current
paths, including earlier layouts, with no file migration or removal.

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
`app_update_progress`, `app_update_check_failed` and `app_update_failed` on stdin;
unknown or malformed lines are ignored, and EOF still means shut down. After the ready line `orbynd` sends
`check_app_update` and `install_app_update` on stdout. Install first checks for
active runs and then holds admission (`503 updating`) under the admission lock, until
exit or until the shell reports an install failure.

`app_update_check_failed` reports a check error without clearing install progress
or releasing admission: a check may finish while an install is in progress.
`app_update_failed` reports an install failure, clears its progress and releases
admission. Both messages carry the error in `message`; check failures keep the
last known release version and notes.

With no shell, `--update-manifest` names a release manifest `{version, notes}` to
compare with the running version; with none, the app reports `unconfigured`. A
server cannot replace itself, so `can_apply` stays false and `blocked_reason` says
what to do.

`POST /api/engines/update-all` updates, one at a time, every engine reporting a newer version
that an owning installer can update. Instances and engines sharing one binary update once, an
engine with a signed warning is left to its recommended install, and each goes through the
single-engine update, so a busy engine or a failed installer is reported by name while the
rest still run. Settings offers Update all when two or more engines qualify.

`GET /api/engines/update-events` sends each step of an engine update while it runs:
`started` with the installer's command, an `output` for each line it prints (stdout and
stderr, a carriage return ending a line, colour codes dropped, 500 characters at most), then
one `finished` with the new version or the error, even when the update is dropped. Nothing is
replayed to a late listener, and a listener that falls behind is disconnected, because it may have
missed a `finished`. Settings → Providers shows the latest line. An update runs to the end and
cannot be cancelled from Orbyn, because stopping an installer partway could leave a half-written
engine: the service keeps it running when the client that asked goes away, and only the update
timeout stops one that hangs.

## Desktop shell

The native product UI loads from the stable bundled asset origin (`tauri://localhost`
on macOS, `http://tauri.localhost` on Windows). Viewer-local storage therefore survives
service restarts and changing loopback ports. The shell supplies the owned service's
origin and launch token in the initial URL. The UI accepts that origin only on these
exact native origins, only as an explicit-port `http://127.0.0.1` origin, and keeps it
when stripping the token into session storage. HTTP, SSE, media and WebSocket callers
use that transport owner. Ordinary local web pages keep same-origin requests and
ignore this native launch parameter. No viewer preferences move into Core storage. This establishes a new stable origin;
it does not inspect, rewrite or merge older development packages' per-port WebKit
or WebView2 stores. Those stores remain untouched.

The product UI has no accepted native commands or Tauri imports. A separate static
`orbyn-startup` origin shows startup/failure with Show log, Try again and Quit. Its
capability is exactly three commands, none taking an argument from the page:
`restart_core` (Try again), `show_core_log` (Show log) and `quit_core` (Quit). A failed
start has no service to ask, so these are the only ways out of it: a person can read why,
try again or leave without a running service. `show_core_log` reveals only the app's own
log, resolved in Rust, never a path the page sends; `quit_core` only exits the app. Each
handler also rejects callers while the top-level window is not on that exact startup
origin and path. That URL check, made when the command is called, is the real guard, and
the capability alone is not: the product UI can navigate the main window onto the startup
page, and it already has these actions (quit, restart, show log) through the service's
shell actions, so this opens nothing new. Preview windows have no capability and a
remote viewer is no window. The page gets one short reason line for a failed start: the
first non-empty line of the service's last words, without control or text-direction
characters, without words that look like a path, an address (`host:port`), an `@` or `=`
value or a 20-character token, and cut at 160 characters. It is not log text.
It follows the system light or dark appearance; the app's own theme choice lives in the
product origin and does not reach this page, and Dim is not offered here.
There are no default core/plugin command permissions. The startup document is embedded,
has no frames or external resources, and displays errors as text. Product actions ask
the service, which asks the shell over stdin/stdout; results return through
`GET /api/shell/events`. `ShellBridge` owns this Core channel. Events wait, eight at
most, for the first window; `GET /api/shell` counts attached windows. Lines belonging
to app updates continue to `UpdateCenter`.

Only a service started with `--parent-stdin` accepts cross-origin native API traffic,
from the two exact product asset origins to a loopback host. Preflight permits only
its explicit methods and request headers. Actual requests still require the per-launch
token, including streams/media; no cookie grant, wildcard origin or `null` origin is
added. Native CSP limits service connections/media to loopback. The service's Host
checks and ordinary local-web Origin checks remain in force.

The window stays on bundled product/startup documents and the running service.
Other `http`, `https` and `mailto` links go to the system browser. Other schemes are
refused, so pages cannot start arbitrary registered programs.

`orbyn://` links come from outside the app, so they only move a window, and only to a
place spelled as a route: `thread/<id>`, `new[/<project>]`, `settings[/<section>]`,
`usage`, `pulls`, or nothing for home. The service turns one into a route and drops
anything else, and a link that started the app waits in the shell until the service
runs. A second launch hands its links to the first and exits.

On macOS the bundle also declares `http` and `https`, and HTML pages at Alternate rank
(`desktop/src-tauri/Info.plist`), so a person can pick the app as their default browser in
System Settings, which lists only apps that declare both. The app never sets
itself as the default. The shell forwards such a link like an `orbyn://` one and decides
nothing. The service drops anything that isn't a short `http` or `https` URL, and it holds
at most eight waiting links. It opens a link only when `open_web_links_in_app` is on, which
is off by default, and only in a preview tab of the live thread in a trusted project that
changed last. The audit actor for that tab is `desktop_link`. The window is then told to
show that tab. A refusal, such as no trusted thread or the setting being off, reaches the
window as a toast. A web link is never handed back to the system browser, because when
this app is the default that would return it here.
Windows declares no web links: a default browser there needs registered capabilities
and a per-person choice in Settings, which the installer does not write.

`POST /api/shell/actions` takes one of a closed list of `ShellAction`s and carries no
path, URL or command. It answers `422` with no shell. The menu bar handles what acts on
the window, and everything else goes to the windows as a `command`, the same ones keys
run. No item claims `Cmd+W` or `Cmd+N`: those are the page's, by its own rules. On macOS
the app menu's Quit keeps `Cmd+Q` only while `quit_confirmation` is `direct`, which the
service sends with `activity`. For `hold` and `double_press` the page owns `Cmd+Q`: it
quits through the `quit` shell action after the key is held for one second, or pressed
again within 1.5 seconds. WebKit may send no keyup while Cmd stays down, so a hold counts
only while key repeats keep arriving; a stop in repeats, lifting the key, blur or a late
press starts over. The page reads the mode again as soon as Settings saves it. A service
in remote mode refuses the `quit` action, so a remote viewer cannot stop the app. Clicking
Quit in a menu or the tray always quits. Windows has no `Cmd+Q` and keeps tray Quit. The zoom
of the main window is kept beside its window state in the app's config folder. Native
Reload, Force Reload, DevTools, Zoom, Paste as Text and Close Window target the focused
application window; without one they do nothing. Viewer zoom is independent and transient.
Main-window close hides it for the tray and running service; viewer close destroys only
that viewer. App-wide commands such as Settings still reveal and target the main window.

The service owns the rule for running work and sends `activity` when it changes: the
counts and whether to stay awake, which is any run unless `keep_awake_during_runs` is off.
The shell applies it. `activity` also counts threads flagged unread and not archived. The
Dock badge counts those unread threads plus runs waiting on a person; Windows has no badge
count, so its tray tooltip names both. The tray shows the rest, and idle sleep is held off, by `caffeinate -i -w` on macOS and
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
shows the log's last line with Try again, and threads and runs are kept. A service
that exits without being asked is started again once, automatically, while the loader
says it is restarting. If the restarted service stops again within ten minutes, the
loader says it restarted once and stopped again, and waits for Try again, which also
earns the next crash its one restart. The product UI restarts the service or shows
its log through the `restart_service` and `show_log` shell actions, which the service
relays and a remote viewer is refused; the product origin still holds no capability,
so the three startup commands stay the startup document's alone. Every
post-spawn startup failure closes the parent pipe and retains child ownership through
a five-second graceful-exit period, then kills and reaps a service that has not exited.
Successful readiness transfers that ownership to the running shell.
The shell allows up to sixty seconds for the first ready line, including cold
bundled-library unpacking and Git indexing. The package-service smoke uses that same
budget; the installed-app smoke retains its ninety-second outer startup deadline.
Timeout still closes the parent pipe and runs the bounded child cleanup above.

The desktop job installs the built package and starts it with a private profile and no
secrets: `scripts/smoke-app.mjs` waits for the UI to connect from the window, checks a
second launch hands over, and sees the service end with the app. `scripts/smoke-package.mjs`
only proves the service runs. The release job adds notarization checks, a SHA-256 per
asset and a CycloneDX inventory from the lockfiles, which fails when a source is empty.
For its private launch, app smoke enables fixed shell startup milestones and prints
an allowlisted summary on failure. It does not publish raw shell stderr, profiles,
service handles or launch tokens through that diagnostic summary.
Windows binaries link the C runtime statically, and the installer is per-user with the
WebView2 bootstrapper embedded and silent. The release workflow publishes nothing: it
leaves a bundle for a person to promote.

The shell passes no data folder, so `orbynd` and the `orbyn` command agree on it, and it
sets no `PATH`: `child_env` widens that for every child without sourcing a shell.

## Per-thread MCP server

`orbynd` serves MCP over streamable HTTP at `/mcp/:thread_token`. The token is
random per run, is passed only to that run's engine, and is revoked at run end.
An ACP agent that does not report HTTP MCP support gets a stdio server instead,
which ACP requires every agent to support: the sibling `orbyn acp-mcp-bridge`,
with the run's endpoint (token included) in `ORBYN_ACP_MCP_ENDPOINT`, never in its
arguments. The bridge relays each JSON-RPC line to the same route, so it adds no
tool, scope or credential. Without a sibling `orbyn` program the agent gets no
MCP server, as before.
Tools: `approve` (Claude permission prompt), `skill_search`, `skill_load`, the
governed `computer_*` tools and `orbyn_*` tools for threads, projects, worktrees,
attachments, preview tabs, published pages, pull requests, delegation, scheduling and
declaring writes. `approve` is listed only for Claude.

An `orbyn_*` tool reaches only the caller's project, its thread's preview tabs and, for
an attachment, its own checkout; anything else reads as not found. A preference a tool
sets is the project's, never a global one. The owner authorized a narrow exception
for project add/remove in issue #127: `orbyn_project_create` registers an existing
absolute folder in place, untrusted, and `orbyn_project_delete` forgets the selected
project and its idle thread metadata while keeping every file. Both are acting tools
under the existing approval policy (including its rules and permission modes), with
a 45-second whole-call budget. Their approval previews show the resolved path,
selected project and bounded thread IDs; caller-supplied internal preview fields
cannot redirect the effect. Adding never creates a folder, clones, moves or trusts it.
`orbyn_project_list` therefore returns exactly the caller's one project, not the
application's project catalog. A folder nested inside it still becomes a different
project when registered; path containment does not grant cross-project authority.
The exception grants no broader project reads, settings changes, thread transfer,
file access, trust or clone operation. Removal refuses the caller's own project,
library and scratch projects, busy threads, changed approval membership and any
descendant cascade crossing into a third project. The identity, membership, busy
and cascade checks, effect audit and metadata deletion share one immediate writer
transaction with run admission. At most 256 thread IDs are accepted for removal;
larger targets are refused. A concurrent duplicate add is refused atomically rather
than returning an existing, possibly trusted registration. Setup/terminal and event
hub cleanup follows commit; no attachment or checkout files are deleted.
Thread transfer is unavailable to tools for the same reason. The product move API
also requires a thread that has never run, which excludes moving the caller's own
running thread even before considering the destination project.
Claude's permission prompt passes Orbyn's own tools without asking, so each tool with
an effect goes through the gate itself as a `tool` action, which needs a person unless
the thread is in full access or a rule allows it. Every call is audited first. A
delegated thread cannot delegate further, so one run cannot fan out without limit.

`orbyn_workflow_stop` requests cancellation of one direct delegated child of the
caller, within the same project. Self, ordinary sibling threads and another
parent's children read as not found. It uses the existing durable cancellation
path, including running delegated descendants, and reports `stopped: true` when
the request is accepted; this is not terminal completion. An idle child returns
`stopped: false`, and cancellation errors are reported. This is a delegated-run
control, not M13's Claude Code workflows, which the person stops from the timeline. `orbyn_thread_wait`
then observes completion, accepts only non-negative integer seconds, clamps at
40 seconds and reports `ended: false` when that bounded wait expires.
The stop tool's entire call, including its approval wait, is capped at 45 seconds;
an expired approval cannot authorize a later effect.

`orbyn_html_render` is how an agent puts a page in its own timeline: it takes `html`,
plus an optional `title` (trimmed, cut to 200 characters, `HTML` when absent) and an
optional `height` (120 to 2000, 480 by default), publishes with the same store as the
HTTP route, and answers with the id, the route, the frame token, the title, the images
copied, the stored size and the height. It carries an effect, so the gate asks. The route
it returns has no query; a client builds the frame URL with `?render=`. Nothing measures
the page yet, so the height the call asks for is the height it gets, and the tool
says so.

`orbyn_pull_guide_write` stores a review guide the calling agent wrote, one per project
and pull request number, replacing the earlier one; `orbyn_pull_guide_read` returns it
or `null`. Like viewed-file marks, a guide is this service's own and never reaches the
forge. The write carries an effect, so the gate asks, and it fails while the project's
`review_guides_enabled` preference is off. Its stops are rebuilt with only their known
fields (title, summary, files with a path and note, questions) and are bounded: 30
stops, a stored size of 128 KiB. Neither tool checks that the number names a real pull
request, and `head_sha` is the agent's own claim.

## Computer gateway

The order is fixed: resolve the target, evaluate policy, write audit, act. Browser
page actions resolve to the current page URL, so rules match where the action
lands. An action with no active run cannot wait for a person, so `ask` refuses and
only an explicit allow rule passes.

## Preview

Moving a preview to another panel changes viewer layout only: the service tab,
profile, navigation and control state stay alive. A second panel has its own selected
tab; returning it never opens or closes a browser. `POST
/api/threads/:id/previews/:tab/window` validates the thread and tab before asking
the attached desktop shell to open or focus that tab's separate window; a plain
service returns `422`. The shell builds a bundled `#/preview/<thread>/<tab>` URL
from its owned service origin and token, accepts no caller-supplied URL, and retains
the same native navigation restrictions. A dedicated viewer shows only that tab
and does not auto-resize the shared page. Closing the window leaves the tab alive;
an explicit Close tab still ends it. Restarting the service closes its old preview
windows and fences queued requests from earlier service generations. Unexpected
service loss follows the ordinary disconnected-page state until restart. Shell
window creation failures use the existing shell error event; the HTTP success means
the request was queued. Native DevTools cannot inspect a remote page from its JPEG
stream, so that action is not doable.

The browser discovers a page's declared icon, falling back to its origin's
`/favicon.ico`, alongside its title. The optional `favicon_url` is metadata only:
the viewer loads bytes through the existing authenticated `/api/media/image`
proxy and its unchanged HTTPS, public-destination, credential, redirect, format,
size and cache limits. Unsupported icons keep a neutral globe. The viewer remembers
at most 50 validated page/icon address pairs after successful loading, separate
from the launch token. Private tabs neither restore nor save remembered icons.
Navigation clears the preceding page's icon until discovery catches up.

A preview tab is a headless Chrome with its own profile, apart from the governed
browser agents use, and needs a trusted folder and an `http` or `https` URL. Up to
four run at once, and they close when their thread settles, archives or is deleted.
Frames are polled about five times a second, only while someone watches or records,
and a frame that did not change is not sent. `/ws/preview` sends each as base64 JPEG
text. Watching gives no control: input needs a person to take the page first.
The separate authenticated `/ws/preview/:thread/:tab/pointer` feed carries only
server-created ephemeral cues after successful agent click or scroll input.
Each tab owns a monotonic sequence; positions are frame pixels, with zoom applied
once at the input owner. Main-frame CDP document lifecycle (including same-URL reload), view changes and browser recovery clear the
cue. Viewers scale it to the actual picture and expire it after 700 ms, with reduced
motion support. A slow viewer skips cues and cannot block approved page input.
Typing and denied actions emit no pointer cue, and an action that fails before
dispatch emits none; a navigation reported after the mouse release can still show its
cue for one frame on the new page. Arbitrary page evaluation is not
interpreted as pointer input. The feed accepts no client-published cues and carries
no typed text, selectors, page URLs or credentials. JPEG frame messages are unchanged.

Recording samples numbered JPEG files in `<data>/browser-artifacts`, including
unchanged pages, at a requested maximum of 1, 2, 5 or 10 FPS (default 5), with no
video encoder. `POST .../recording` accepts `PreviewRecordingOptions` as query
parameters; omitted options retain the defaults. Mouse and key overlays default
off. Successful mouse presses use the actual dispatched frame point. Key labels
come only from the fixed Enter, Tab, Escape, arrow, Backspace and Delete vocabulary
after successful human key dispatch. Printable text never becomes a label. A
boolean focus check before dispatch and capture suppresses labels for text fields,
passwords, OTP, frames, shadow hosts, BODY, editing mode and uncertain focus; this
check does not restrict human input. Overlays are drawn into saved JPEG pixels,
without injecting UI into the page or changing streamed JPEGs.

Each recording owns its captured cues, writer, successful frame/byte counts and
summary. Stop cancels new frames and waits for the actual blocking writer before
returning the saved path and frame count; cancelling an awaiting caller cannot
release the writer's compositor permit early. The frame loop never waits on
encoding: it hands each frame to a one-slot per-recording queue where the newest
replaces a waiting one, and only that recording's own task takes the shared
compositor gate, so a slow encoder cannot stall live viewers. Finished state and
errors are readable while the writer is busy. A new recording is refused with an
error once recordings under the folder total 2 GiB; nothing is deleted
automatically. Limits are five minutes,
3,000 frames and 256 MiB including reserved summary space. Input JPEGs are capped
at 16 MiB and 4,096 pixels per dimension. A limit or write failure stops capture
and retains an error. Failed summary publication retains the stopped owner for a
Finish retry and blocks replacement until publication succeeds. The Browser panel
shows the server's successful count and folder after Stop, and a committed
Start/Stop remains authoritative when its status refresh fails.

Agents can read their thread's
tabs with `orbyn_preview_snapshot` and `orbyn_preview_wait_for`, and drive them
with `orbyn_preview_act` (click, append text, scroll) and `orbyn_preview_evaluate`
(page JavaScript). The acting tools use the normal `tool` approval gate. Taking
control guards a person's input against a watcher's stray input; it does not
suspend approved agent actions.

Snapshots keep semantic elements separate from the page's text sample, include
visible fixed controls, and name fields from `aria-labelledby`, `aria-label` or
associated labels before falling back to their contents and hints. Password
values are omitted. Selectors must uniquely identify their element; entries that
cannot fit a whole selector in 300 characters are omitted with `truncated: true`.
Snapshots default to 150 elements (300 maximum), 4,000 characters of text and
120-character names and values. Expressions are limited to 2,000 characters and
typed text to 4,000; evaluate returns a whole value or its byte count above 20,000
bytes. A wait defaults to five seconds and is capped at twenty, with one deadline
covering session lock acquisition, selector validation, CDP reads and polling.

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

A previewed page is untrusted, so what crosses between it and the person waits for
the person's own action and stays inside the tab's folder, `<data>/preview-files/<tab>`,
which ends with the tab. Copy (Cmd or Ctrl+C on the page a person holds) reads the
selection in the focused field, or else the page's, and nothing from a password field,
into the person's own clipboard; a page's own clipboard writes stay in its browser.
Paste is the person's paste event, typed into the page as text. A file chooser the
page opens is held, not failed: the panel asks the person, who picks files through
their own system picker; each, at most 50 MiB and 256 MiB a tab, is uploaded to the
tab's folder and handed only to the input that asked, and Cancel hands nothing.
Downloads save to the tab's folder under the browser's own id, never the page's name
or path; a download past 1 GiB is stopped, and a tab keeps 20, dropping the oldest
finished one. Saving one serves its bytes as an `application/octet-stream`
attachment, `nosniff` and sandboxed, under the page's name made safe for Windows and
macOS, and the person's browser chooses where it goes. Handing files to a page and
saving a download are audited.

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

## Remote image security

Message images use `GET /api/media/image?url=...`, an authenticated capability
owned by Core and served by `orbynd`. Image elements may supply the launch token
only on the exact GET/HEAD route; Host, Origin and native-origin checks still apply.
The web and bundled desktop CSPs keep direct remote images and connections closed.
The proxy is the decision for issue #122, rather than adding `https:` to `img-src`.

An upstream URL is at most 4096 bytes, HTTPS on port 443, without user information.
Fragments are discarded. All DNS answers (at most 16) must be public unicast;
private, loopback, link-local, reserved and IPv6 transition ranges are refused.
The validated addresses are pinned to that request's HTTP client, with ordinary
TLS certificate validation, no environment proxy and no redirects. No browser
cookies, launch token, Authorization, Referer or upstream response headers are
forwarded. A request has five seconds total including waiting for a fetch slot,
DNS and body reading. At most four upstream fetches run at once; an uncached
request waits for a free slot within that same budget, then fails if it expires.

Only PNG, JPEG, GIF, WebP and ICO MIME/signature pairs are served, up to 5 MiB
of actual streamed bytes. Encoded bodies, SVG, HTML, AVIF and other formats are
refused. Successful bytes are cached in memory for 60 seconds, with FIFO eviction
at 32 entries or 32 MiB; nothing is persisted. Browser replies are `no-store`,
`nosniff`, `no-referrer` and sandboxed with `default-src 'none'`. Save requests
receive an attachment disposition; Copy link keeps the original URL rather than
exposing the launch-token-bearing proxy address. Failures show the existing
unavailable state, with no direct-URL retry.

This is still an outbound request selected by untrusted agent output. The image
host sees the service's IP and the full URL, including agent-supplied query data;
tracking and URL-based exfiltration remain possible. The proxy enforces network
and resource limits; it does not establish consent or make remote content private.
Remote videos remain outside this capability. Preview favicons use this same
boundary: the browser discovers a declared icon and the viewer fetches its bytes
through this route, so H38 adds no broader fetch permission. C22's scan and render
sandbox remain separate and receive no remote-fetch permission from this route.

## Persistence

SQLite in WAL mode in the OS app-data directory. Migrations are ordered and
forward-only, applied in a transaction at startup, and recorded in
`schema_migrations`. A database from a newer version is refused, not opened. A start
that moves an existing database forward reports `database_upgrade: {from, to}` in
`/api/info`, and the web shows one toast per upgrade; a database this start created
reports nothing. Orbyn has no older thread database to import (A54), so this forward
upgrade is the only migration event.

Secret files are created with mode `0600` on Unix. Windows has no mode bits: they
inherit the ACL of the per-user `%LOCALAPPDATA%` directory, which excludes other
non-administrator users. Orbyn does not set its own ACL.

The CLI service handle is published through a private, exclusively created file
beside `service.json`, then renamed over the destination. Concurrent readers see
one complete record. Failed publication leaves the prior handle intact and removes
only its owned staging file. On the normal startup path, publication precedes
readiness, so an immediate CLI reader needs no retry. A publication error retains
the existing warning that the CLI will not find this service.

## Child environment

Everything Orbyn spawns goes through `child_env`. Started inside a Claude Code session,
`CLAUDECODE` and the rest of that host's `CLAUDE*` variables are removed, which matters
because some put a child into a reduced mode. `CLAUDE_CONFIG_DIR`, the provider switches
and `CLAUDE_CODE_OAUTH_TOKEN` are a person's own settings and stay. Orbyn does not create,
switch, copy or delete Claude config homes: one Claude login is used per instance, and a
second account by config directory stays the CLI's own arrangement. `CODEX_SANDBOX`-style
session markers go always, and an AppImage's variables and its mount's entries in
library, data and `PATH` lists go when `APPIMAGE` and `APPDIR` are both set. The
`prefer_saved_login` preference also drops API keys and endpoint overrides from engines
only, so they use their own login. Engine consoles and terminal engines count as
engines; a plain shell terminal does not. `EngineStatus` reports inherited credentials by
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

`orbyn triage [--agent claude|codex] [--model MODEL]` starts a fresh native
support session in the selected data folder's `triage/<id>` directory. Core owns
the provider choice, support files and literal launch arguments; the CLI owns
foreground terminal I/O. The provider's own login and permissions apply: this is
outside Orbyn governed runs, with no thread resume, project admission or MCP
approval gate. Resuming a thread's session is the engine console under
[Terminals](#terminals), not this command. The files
contain only CLI build/platform/time metadata and original support instructions;
no service handle, logs, database, environment dump or credentials are collected.
Server status is explicitly not checked. Additional investigation, repairs,
network retrieval and publication require the person's approval.

In the app, `GET /api/triage/playbook` returns the opening message for a triage
thread: the running service's version, channel and platform, a link to its source
(the build's `ORBYN_SOURCE_REVISION`, or the main branch, marked as possibly different)
and the same limits as the command line's prompt. About puts it in a new draft without
a project; the person picks the agent and sends it, and the thread is an ordinary
governed run. Orbyn fetches no source and reads no logs for it.

One available provider is selected automatically; two require both input and
output to be terminals for the picker, or an explicit `--agent`. With neither,
the files remain for manual use. Discovery resolves executables without a version
or authentication probe. Existing executable overrides and recognized Windows
shim resolution apply; unsupported wrappers are refused rather than evaluated by
a shell. The child inherits terminal streams and the parent waits for its exit.
Numeric child exits are passed to the OS unchanged, including full Windows
32-bit statuses; exits without a code report failure. Native terminal interrupt behavior remains the provider's;
there is no forced descendant-cleanup or parent-death guarantee. See
[the CLI reference](cli.md).

For normal workspace use, `orbyn` is a client of a running service: `thread`, `project`,
`theme`, `status` and `doctor` go through the API the UI uses, and `serve` runs `orbynd`
from beside it. It finds the service in `service.json` in the data folder (`--data-dir`,
`ORBYN_DATA_DIR`), holding the URL, the launch token and the process id. That file is
private like any secret file and goes when the service stops; one left by a crash reads
as nothing running. Exit codes are 0, 1 when a request was refused or a waited-on run
did not complete, and 2 when no service is running. `--json` prints the API's answer.

`orbyn`, `orbyn <folder>` and `orbyn start` reuse a service that answers or start one that
outlives the command, with its output in `service.log`, then open it in the browser with
the token in the address, which the page moves out of history. A folder is registered
first, untrusted, and reused if it is already a project, including when a child folder
resolves to its Git root. A packaged CLI serves the UI and library snapshot beside the
Windows sidecars or in the macOS bundle's Resources folder, just as the shell does.
Explicit `serve` flags override those bundled paths. A bare name counts only if the
folder exists, and nothing is started otherwise. The token is never printed. `orbyn app`
goes through the `orbyn://` link, so it starts the desktop app by the system's own route and
adds no way in. `ORBYN_OPENER` names another program, or `-` to print what would open.

`orbyn browser setup` needs no service: on macOS and Windows it reports that
nothing needs setting up, without creating a data directory or changing the host.
Linux browser setup is outside the supported product scope and is not performed.

A detached Windows `orbyn start` clears the inheritance flag on the launcher's
original standard-stream handles before spawning `orbynd`. The launcher's streams
remain usable for its result, while the daemon gets only its explicit null input/
output and service log as standard streams. Redirecting the daemon's streams alone
does not prevent Windows from inheriting an original pipe handle.

`orbyn service` runs the service from this user's login through the OS's own manager:
launchd on macOS or systemd on Linux, with no administrator rights. Background setup
reports unsupported on Windows before invoking a manager or changing files, matching
T3; Windows desktop startup and direct `service run` remain available. Each change is a plan of
one file and some commands, and `--dry-run` shows it and does nothing. Installing again
repairs it, uninstalling leaves all data, and neither reads a credential. What the manager
starts is `orbyn service run`, which adds `service.env` from the data folder to `orbynd`'s
environment. It accepts dotenv assignments, optional `export`, quoted multiline values
and comments without shell evaluation or variable expansion. Malformed assignments stop
startup with a line number. The launcher keeps its inherited `PATH` and chosen
`ORBYN_DATA_DIR`, including case variants on Windows. A missing file is ignored; other
read failures stop startup. That file is the person's and stays out of Orbyn's rules and store. It
shares the data folder's single lock, so a desktop app on the same folder cannot start
while the service runs.

`orbyn trace summary` reads this data folder's `logs/server.trace.ndjson` and ten
rotated files without connecting to a running service. Core owns payload-free timing
records: registered operation name, elapsed milliseconds, end time and outcome.
HTTP instrumentation supplies method and registered route template, never request
IDs, query strings, headers, prompts or error text. An unfinished operation records
an interruption. Each file rotates at 10 MiB; recording failures do not fail the
operation. The reader snapshots each file length and bounds scanned bytes, record
length, distinct names and retained samples. Malformed lines are counted, not
interpreted as spans. Summaries sort busiest names first and report count, rate,
nearest-rank p50/p90, maximum, interruptions and failures. `--since` filters by end
time and `--limit` controls displayed names. Missing files produce an empty report
without creating the data folder. This is local timing evidence for the CLI report and is
separate from the OTLP exporter above.

The GitHub-star notice counts acknowledged composer submissions in two separate
viewer-storage entries: sent threshold and dismissal. It checks this app's fixed
public repository after the sixth prompt and appears once per page session until
closed. Button, link, close-icon and bottom-right swipe dismissal share the same
saved dismissal. Storage failures suppress the notice, and a dismissal from another
tab wins over an in-flight check. Core uses a bounded, noninteractive `gh api` GET
for the fixed repository; it captures no output, reads no credential file and never
stars anything. Missing tools or an unavailable check do not interrupt a send.
The web reload flow is qualified. Native viewer storage now has a stable bundled
origin, with Light persistence qualified across isolated macOS quit/relaunch and
service recovery. Star-notice dismissal across native quit/relaunch itself remains
unverified; the shared storage correction is not a substitute for that walkthrough.


## Service configuration

`orbynd serve` takes `--port`, `--data-dir`, `--ui-dir`, `--library-bundle`,
`--workspace-url`, `--update-manifest`, `--remote`,
`--tls-terminated`, `--allowed-host` and `--parent-stdin`, and prints one JSON line
`{url, token}` on stdout once it can serve, after registering stop handlers and writing
the CLI's service handle. A stop immediately after that line still cleans up the handle.
`--skills-dir` is accepted and ignored
for older shells. Environment: `ORBYN_DATA_DIR`, `ORBYN_ACP_REGISTRY_URL`, `ORBYN_LIBRARY_BUNDLE`, `ORBYN_WORKSPACE_URL`, `ORBYN_UPDATE_MANIFEST`, `ORBYN_CLAUDE_BIN`, `ORBYN_CODEX_BIN`, `ORBYN_CODEX_SANDBOX` (default
`workspace-write`), `ORBYN_APPROVAL_TIMEOUT_SECS` (default 1800),
`ORBYN_AGENT_DESKTOP`, `ORBYN_BROWSER`, `ORBYN_BROWSER_HEADLESS`,
`ORBYN_BROWSER_IN_PROCESS_GPU`, `ORBYN_OFFLINE`
(skip latest-version lookups) and `ORBYN_LOG`.

## HTTP API

All bodies are JSON and errors are `ApiError` with a stable `code`. Auth is
`Authorization: Bearer <token>`, or the session cookie. SSE, WebSocket and
`files/raw` and the exact GET/HEAD `/api/media/image` route also accept `?token=`
because browsers cannot set headers on them.

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | `ServerInfo` |
| `GET, HEAD /api/media/image?url=&download=` | Bounded public HTTPS raster image; authenticated, no redirects; `502 image_unavailable` on refusal/failure; `download` forces an attachment |
| `GET /api/workspace` | `WorkspaceStatus` |
| `POST /api/workspace/setup` | Optional. `WorkspaceSetup`: adopt a library, or ask for the clone now; `409 runs_active`, `409 library_dirty` |
| `POST /api/workspace/update` | `{apply}`: fetch and report, or fast-forward |
| `POST /api/workspace/rollback` | Back to the revision before the last update |
| `GET /api/projects/:id/pulls/:number/revisions`, `GET /api/projects/:id/commits/:sha/files` | A pull request's commits, oldest first, and what one commit changed |
| `GET /api/diagnostics`, `POST /api/diagnostics/processes/:pid/stop` | `Diagnostics`, in memory only; a stop reaches only this service's own descendants |
| `GET /api/projects`, `POST /api/projects/:id/trust` | Projects and folder trust |
| `POST /api/projects/add` | `AddProject`: register a folder in place; `403 workspace_refused`, `409 project_exists` |
| `GET /api/projects/:id/icon` | `ProjectIconImage`; bounded passive registered-root metadata, no path or URL argument |
| `GET /api/projects/:id/icon/resource` | `ProjectIconResource`; checked image metadata and content revision without embedded bytes |
| `GET, HEAD /api/projects/:id/icon/raw`, `/api/projects/:id/images/raw?path=` | Selected/candidate image bytes, checked registered roots, conditional and range handling |
| `POST /api/settings/projects/image-search` | `SearchProjectImages` → `ProjectImageSearchResult`; selected representative, fenced membership and bounded local search |
| `POST /api/settings/projects/image` | `ChangeProjectImage` → `Project[]`; same relative image hint with membership and metadata revision compare-and-set |
| `POST /api/settings/projects/icon` | `ChangeProjectIcon` → `Project[]`; selected structured icon/reset with membership and metadata revision compare-and-set |
| `POST /api/settings/projects/rename` | `RenameSelectedProjects` → `Project[]`; selected names with membership and raw-name compare-and-set |
| `POST /api/settings/project-scopes` | `ProjectScopesQuery` → `ProjectScopeCatalog`; full-app read, stale selections remain unavailable |
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
| `GET /api/source-control/repository-star` | Fixed product repository star status; full-app read, no star mutation |
| `GET, POST /api/tasks` | `ScheduledTask[]`; `UpsertTask` creates or changes |
| `PUT /api/tasks/:id` | The whole `UpsertTask`; `404` if unknown, `400` for another task's `id` or another project |
| `DELETE /api/tasks/:id`, `POST /api/tasks/:id/enabled` | Delete; `TaskEnabled` pauses or resumes |
| `POST /api/tasks/:id/run` | Fire now (`202`, `{thread_id}`) |
| `POST /api/tasks/:id/webhook` | `WebhookEndpoint`: issue or rotate the token, shown once |
| `GET /api/tasks/:id/webhook` | `WebhookAddress`: whether a token exists and the address up to it; the token itself is never returned |
| `GET /api/tasks/:id/runs` | `TaskRun[]`, the last 50 firings, newest first |
| `GET /api/tasks/:id/deliveries` | `WebhookDelivery[]`, newest 200, each with `from` when the request names a sender |
| `POST /hooks/:id/:token` | Public webhook; `202` accepted, `200` with a status, `404` otherwise |
| `GET, PUT /api/preferences?project_id=` | `PreferenceView[]`; `SetPreferences`, where `null` resets |
| `PUT /api/projects/:id/preferences` | Project overrides |
| `POST /api/projects/:id/pull` | Fast-forward a clean checkout |
| `GET, POST /api/keybindings` | `KeybindingsView`; add or change a `KeybindingRule` |
| `GET /api/diagnostics`, `POST /api/diagnostics/repair` | `Diagnostics`; `409 runs_active` |
| `POST /api/diagnostics/otlp` | `OtlpCheck` to `OtlpResult` |
| `GET, POST /api/storage/cleanup?dry_run=` | Last `CleanupReport`; apply the retention rules |
| `GET /api/storage/cleanup/preview` | `CleanupPreview`: counts and bytes per kind that a run now would remove, and what it would hold back (uncommitted or shared worktrees). Changes and records nothing |
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
| `POST /api/threads/:id/mcp-apps/:render_id/tool-call` | An MCP App's confirmed tool call on its own server |
| `POST /api/threads/:id/mcp-apps/:render_id/message` | An MCP App's confirmed message, queued |
| `PUT /api/threads/:id/mcp-apps/:render_id/context` | An MCP App's note for the next turn |
| `DELETE /api/threads/:id/mcp-app-context` | Drop the unsent app note |
| `PATCH, DELETE /api/queue/:id` | Edit or remove a queued message |
| `POST /api/queue/:id/send-now` | Send next, stopping a running turn for it |
| `POST /api/threads/:id/steer` | `SteerRun`: add text to the running turn (`422` if unsupported); a selection applies from the next turn |
| `GET, POST /api/threads/:id/attachments?name=` | Raw upload body; `Content-Type` is the kind |
| `DELETE /api/attachments/:id` | Remove an attachment |
| `GET /api/attachments/:id/content` | The stored bytes with their recorded `Content-Type`; `404` once gone |
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
| `POST /api/pulls/details` | `PullDetailsResponse` for listed rows: reviewers, viewer review, comment totals, opened time; `paused` names details withheld by a spent rate limit |
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
| `GET /api/threads/:id/workflows/:call/script` | `WorkflowScript` of a Claude Code workflow the call launched; `404` for any other call |
| `POST /api/threads/:id/workflows/:call/stop` | `WorkflowStop` (`202`): ask the running engine to stop that workflow; `400` once it has ended |
| `GET /api/threads/:id/events` | SSE `ThreadEvent`, resumes from `Last-Event-ID` |
| `GET /api/approvals?state=pending`, `POST /api/approvals/:id/decide` | Approvals |
| `GET /api/threads/:id/diff?scope=` | `FileDiff[]`: `worktree`, `turn&run=`, `thread`, `branch&base=`, `commit&sha=` |
| `GET /api/threads/:id/jj` | `JjStatus` of a non-colocated Jujutsu checkout, or `null`; `422` without `jj` |
| `GET /api/threads/:id/setup` | `ThreadSetup`, or `null` when the checkout ran no setup |
| `POST /api/threads/:id/setup/cancel` | Stops a preparing or running setup; returns `ThreadSetup` |
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
| `POST, DELETE .../previews/:tab/recording` | Start with optional `PreviewRecordingOptions` query; stop, to `PreviewRecording` with successful frame count and optional error |
| `POST .../previews/file` | `OpenPreviewFile` to `PreviewTab`, inside the checkout |
| `POST .../previews/:tab/view`, `/reload`, `/clear`, `/pick` | `PreviewView`; `ReloadPreview`; `ClearPreview`; `PickPreview` to `PickedElement` |
| `GET, POST /api/browser-profiles` | `BrowserProfile[]`; `CreateBrowserProfile` |
| `DELETE /api/browser-profiles/:id`, `POST .../clear` | Remove, or empty, a profile no tab has open |
| `GET /ws/preview/:thread_id/:tab` | Base64 JPEG text frames |
| `GET /api/threads/:id/servers`, `POST .../servers/:pid/stop` | `LocalServer[]`; stop one in this checkout, otherwise `404` |
| `POST /api/threads/:id/console` | Opens the engine's own console on the thread's session |
| `GET /ws/terminal/:thread_id` | Main PTY: binary in/out, JSON text frame `{cols,rows}` resizes |
| `GET /ws/terminal/:thread_id/:terminal?observe=` | Attach to a named terminal; `observe` is read-only |
| `GET, POST /api/threads/:id/terminals` | `TerminalInfo[]`; `OpenTerminal` with `split_of` and `direction` |
| `PATCH, DELETE /api/threads/:id/terminals/:terminal` | Rename, close |
| `GET, DELETE /api/threads/:id/terminals/:terminal/scrollback` | `TerminalScrollback`; clear |
| `GET, POST /api/threads/:id/scripts` | `ProjectFileView`; `RunScript` to `TerminalInfo` |
| `GET /api/engines`, `POST /api/engines/refresh` | `EngineStatus[]`; `account` is the signed-in account when the CLI's own status names one (Claude's email; Codex names none) |
| `GET /api/health/dependencies` | `DependencyHealth`: one empty `GET` each to `api.github.com` and, for an installed Claude or Codex, its provider's host; any HTTP answer is reachable. Only when asked, listed in `/api/network`; offline mode makes no request and says `checked: false` |
| `POST /api/engines/probe-binary` | `ProbeBinary` `{path}` to `BinaryProbe`: whether an absolute path is a runnable file and the version `--version` printed. No shell, fixed argument, 5 second limit; a relative path is refused with a `problem` |
| `GET /api/engines/:id/native-sessions/count` | `NativeSessionCount`: conversation files in the engine's own history folder (`claude`, `codex`); counted, never opened; `422 unsupported` for other engines |
| `POST /api/engines/:id/update` | Run the owning installer (`409 engine_busy`) |
| `GET /api/engines/update-events` | SSE `EngineUpdateProgress` while an engine update runs |
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
