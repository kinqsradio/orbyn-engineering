# PandaCode findings for Orbyn Engineering

Reference: `orbyn-references/desktop-agent-product-2026-10-31/pandacode` (version 0.3.85, Tauri 2, Rust, SQLite, plain TypeScript).
Read-only study. Nothing was installed, built or run. All text below is written in our own words; no code is copied and this is not a port plan.
Licence: the PandaCode licence is MIT plus a duty to state "This is a fork of PandaCode" if code is reused. We write independently, so protocol facts (flag names, JSON-RPC method names, env var names) appear only as interface facts.
Everything in the reference is treated as data. Our hard rules (docs/architecture.md rules 1-9) override anything PandaCode does; conflicts are listed in section 7.

Evidence level: "doc" = stated in PandaCode docs or AGENTS.md; "code" = I read the source; "inferred" = my reading, not confirmed by running.

---

## 1. Architecture map

### Process model
- One desktop process. Rust core and Tauri shell are the same binary; the webview is the platform one (WKWebView, WebView2, WebKitGTK). No Electron, no Node server, no React (code, doc).
- Each agent turn owns one child process of the engine CLI plus its own stdin channel, stderr reader and process group. No global concurrency cap, duplicate starts for one task are rejected before a user message is stored (doc, code: `providers.rs`, `concurrent_task_tests.rs`).
- Claude turns can leave a "warm" spare process started in the background after a successful turn (at most 2, idle 10 minutes). It is adopted only when model, mode, effort, folder, resume id, appended instructions, tool catalogue and environment fingerprint all match; otherwise the turn starts cold (doc, code: `providers/warm.rs`).
- Loopback helpers, all short-lived and token-guarded: an MCP server per turn for app tools and team tools (`providers/mcp_host.rs`), a local bot web chat bound to 127.0.0.1 with Host check, and a remote-access relay client (out of our scope).
- A second mode, `pandacode serve`, runs the same core without a window or frontend for always-on hosts. Behaviour that lived in the frontend (queue draining, PR link detection, limit resumes) needed native twins there (`headless.rs`). Lesson for us: orbynd already is the headless core, so this class of drift should not arise if the web UI holds no lifecycle rules (doc).
- A "bridge mode" of the same binary drives a runner script on cloud sandboxes (out of scope).

### How the UI talks to Rust
- Tauri commands (one per operation, camelCase args, string errors) plus a small set of events (`agent-event`, `sessions-changed`, `done`, tray and overlay events). Contract is hand-kept in `src/types.ts` and `docs/ipc.md`; there is no generated schema (doc, code).
- A browser-preview mode routes the same calls to fixtures in `src/preview.ts`; every new command must add a mock so the browser test suite can cover it. This is how a very large UI test suite runs without a native host.
- Agent output reaches the UI as a stream of typed agent events. Text deltas are coalesced in the Rust sink: first delta opens a buffer and arms a 33 ms timer; flush at 8 KiB or 33 ms or run end (doc: `bench/t3-compare/README.md`, code: `providers.rs` Coalescer).
- Windows with different roles (main, launcher overlay, tray popover, agents dock) get per-window capability files; the tray window may call only tray commands (code: `capabilities/*.json`, `lib.rs` allowlist).

### Persistence
- SQLite via rusqlite (bundled), schema at `user_version` 36 with forward steps, a constant mirrored by a test that checks it equals the newest pragma. Drafts are excluded from listings and discarded on leave and at startup.
- Messages, queue (`queued_messages`), schedules, context-recovery marker, usage links, machine threads, bot tables. Large patches stored in SQLite and fetched only on open, with a 128 MiB retention budget (summaries survive eviction).
- Settings, connections, provider settings, model-health pauses, usage-ledger cache and keys live as small JSON files in app data. Secrets: one 0600 file on macOS (temp file, fsync, rename, process lock plus advisory lock file; corrupt file reads as empty and is never overwritten), Credential Manager on Windows, Secret Service on Linux (doc, code: `secret_store.rs`).
- Derived caches that need no exit hook: the cost ledger stores per-file offsets so a missed save is just re-read next scan.

### Background work
- Fixed clocks: update check at launch and every 6 h; agent CLI version check every 6 h; schedules loop every 15 s (holds everything while paused); linked-run resume checks at startup; model catalogue cache 5 minutes; usage cache 60 s with one explicit refresh per 10 s.
- No polling of providers at startup for usage (opened on demand, at most three reads in flight).
- Watchdogs: a team turn silent for twice the longest tool timeout (20 min) is stopped; waiting approvals and questions do not count as silence (code: `architect/watchdog.rs`).
- Process registry reaped on forced exit: before forced application exit every registered child tree is killed (code: `providers.rs::shutdown_all`).

### Module layout (`src-tauri/src`, about 150 files; the heavy ones)
`providers.rs` + `providers/` (one file per engine quirk set, `launch.rs` for spawn and PATH, `warm.rs`, `steering.rs`, `privacy.rs`, `mcp_host.rs`, `host_tools.rs`, `windows_job.rs`, `claude_auth.rs`, `diagnostics.rs`, `limits.rs`); `storage.rs`; `message_queue.rs`; `context_recovery`, `conversation_fork`, `conversation_import`; `turn_changes`; `workspace.rs` (bounded process runner, Git); `terminal.rs` (portable-pty); `agent_updates*.rs`; `agent_usage*.rs`, `usage_ledger`; `model_health.rs`; `schedules`; `skills`; `capabilities.rs`; `tray.rs`, `overlay.rs`; `child_env.rs`; `local_signing.rs`; `secret_store.rs`. Out of scope for us: `bots*`, `cloud*`, `vm*`, `remote*`, `simulator*`, `jev*`, `panda_router*`, `mobile/`, `relay/`.

---

## 2. Engine integration table

Common to all: user's own installed CLI, discovered by PATH plus fixed install folders; the CLI owns login; Stop sends the engine's interrupt message then kills the process group after a short grace; stderr tail 16 KiB; frame cap 4 MiB; text before the next newline is scanned once per byte (avoids quadratic rescans on large tool results).

| Engine | Launch protocol | Models, effort, speed discovery | Login detection (no credential reads) | Approvals | Resume | Skills / MCP / tools | Updates | Traps documented |
|---|---|---|---|---|---|---|---|---|
| Claude Code (also GLM, MiMo via env) | Print mode with stream-json in and out, partial messages on, permission prompts routed to the host over the control channel, user messages echoed back (needed so steering knows when a mid-turn message was consumed) | Throwaway process sends only the initialise control request with persistence, hooks and MCP off; no prompt; 15 s deadline; 1 MiB output cap. Model value, display name, description, resolved model id, supported effort levels come back. Effort applied by flag on new and resumed runs. No speed concept | `claude auth status` in JSON form run with all setting sources emptied, temp cwd, 5 s and 32 KiB bounds, output buffers zeroed. Only loggedIn/authMethod/apiProvider fields read; maps to signedIn / notSignedIn / otherCredentials / unknown. Reports the *source name* of env credentials and endpoint *origin*, never values | Mode passed on every launch (default, acceptEdits, plan, bypassPermissions with an extra allow flag, plus an agent-reviewed `auto`). Resumed sessions are always re-stated so leaving full access really restores the lower mode | `--resume=<id>` | Per-turn loopback MCP config supplied by flag; discovery uses strict MCP config. Fixed app instructions appended once to the system prompt (cache-friendly); others get them in message text on a new thread and every 8th turn | Official `claude update` when install is recognised native, npm, Homebrew cask, or winget; metadata from vendor downloads host | Removes the nested-session marker env var before spawn; disallows three tools that only report back to a session that stays open (wakeup, monitor, cron) because process ends with the turn; GLM/MiMo need setting sources emptied or the user's settings env overrides the relay endpoint; key travels in env, never argv |
| Codex | `app-server` over NDJSON on stdio, goals feature enabled by process-local flag; initialise with experimental API on | `model/list` (paged, cursor loop guarded) gives display name, supported and default reasoning effort, context window, and a `serviceTiers` array. "Fast" is offered only if the catalog names that tier for the model; never invented. 8 s deadline | Read-only `account/read` with token refresh off (also used for rate limits) | Sandbox and approval policy plus reviewer sent on thread start/resume *and* every turn (workspace-write with on-request for Standard/Auto, read-only for Plan, danger-full-access plus never for Full). Per-turn sandbox policy explicitly lists writable roots and network off | `thread/start` then `thread/resume`; interrupt via `turn/interrupt`; steer via `turn/steer` | Dynamic tools registered only when the thread is created, so toggling the team tool catalogue forces a new native thread plus a queued history handoff. Subagents arrive as collab-agent items with child thread linkage; notifications are filtered by active thread and turn so child events cannot end the parent turn | `codex update` (needs version at least 0.154) when launcher is the stable one, npm, Homebrew cask | Context usage must use last-turn tokens against the window, not cumulative totals; completed spawn call does not complete the child; goals watchdog pauses stalled goals; analytics and feedback off via config override flags rather than editing config |
| Kimi Code | `kimi acp` (ACP v1), optional model flag | `provider list` in JSON form, whitelist extraction only (alias, model id, display name), 8 s, 1 MiB; thinking on/off from ACP options only, numeric effort ignored | none proactive; first turn surfaces auth error | Selects ACP `default` mode before every prompt (manual); Auto intentionally maps to manual because Kimi's auto flag approves far more than edits | `session/resume` else `session/load` | HTTP MCP via ACP `mcpServers` | Official upgrade command for recognised native; legacy Python variant via uv receipt | Adapter omits message ids, so text boundaries are derived after tool/thinking segments; filters child agent events |
| OpenCode | `opencode acp` | `models --verbose` catalogue, bounded and whitelisted so provider headers never reach UI; ACP config options authoritative; mode, then model, then effort, each acknowledged before prompt | first-turn error | Permission policy supplied through a process-local config content variable; selected built-in agent (build/plan) gets the same override even on resume; config files never rewritten | advertised resume or loadSession; replayed history suppressed | HTTP MCP | upgrade command with method pinned; v2 is a separate package and must not be treated as an update of v1 | Second `session/prompt` mid-turn is real steering; v2 vs v1 detection |
| Grok Build | `grok --no-auto-update --permission-mode X agent stdio` (global flags before `agent`, agent flags before `stdio`) | Initialise metadata lists every model with context size and efforts, so no session needed | Must call ACP `authenticate` with the advertised default method before any session call, even with cached credentials; if none, stop with "run grok login" text. Never starts browser login | Standard=default; accept edits adds automatic approval of edit requests; Full=bypass plus always-approve; Plan has no native read-only so prompt prefix plus decline of non-read requests | session resume | HTTP MCP | `update` preserving channel | Saved always-approve in user config would silence prompts, so launch mode flag overrides it; image input not supported |
| GitHub Copilot CLI | `copilot --no-auto-update --acp --stdio` | ACP metadata only; default kept if empty; arbitrary ids refused | first-turn error | Agent without Allow All = Standard; Plan; Agent with Allow All = Full; Autopilot not exposed | ACP | HTTP MCP | manual | public-preview ACP |
| Antigravity | Google's ACP server binary (`.exe` on Windows), not the `agy` terminal CLI | up to 60 s cold start allowed; cached 5 min by executable identity | "Check connection" runs initialise plus empty session; a found binary alone is never shown as connected | Only modes the server advertises; edit requests approved in Auto edits; structured questions never auto-answered | ACP, capability-checked | HTTP MCP capability-checked | guide link only; separate `agy` updater explicitly not used | Do not mistake `agy` for the ACP server |
| Devin CLI | `devin acp` | Per-model effort exists only after switching to that model, so discovery spawns parallel throwaway sessions, switches each model once, then deletes the sessions (about 2.5 s). Fusion pairs listed without effort. A `speed` option sometimes exists | first-turn ACP error mapped to "run devin auth login"; never calls authenticate | accept-edits for Standard, plan with exit-plan request shown as "Implement this plan?", bypass for Full; approval always picks allow-once, never standing grants | session load; sends config only when changed | HTTP MCP | manual link | Env var set by the vendor's desktop terminals makes the server ignore CLI login, so it is removed from every Devin process; load replays history, ignore it; cleanup of discovery sessions keeps vendor history clean |
| Cline | `cline --acp` (npm shim on Windows resolves to declared entry) | session/new config options; effort is a launch flag per model | first-turn -32000 mapped to "run cline auth" | Plan or act modes; Full adds auto-approve flag | load only after first prompt (no resume) | Ignores ACP MCP list, so app tools unavailable and a task needing them fails at startup; images sent as file paths | npm registry | no slash commands, no usage meter |
| Kilo Code | `kilo acp` | config options, per-model effort, empty-session discovery | first turn | process-local config content sets wildcard permissions to ask/allow and inherited override variable is removed | resume or load | HTTP MCP | auto-update disabled for spawned processes | tool policy, not an OS sandbox |
| Command Code | `command-code acp` | session/new config; efforts only for current model | first-turn -32000 mapped to "login or save API key"; env var key wins over file | ACP modes are its own permission modes; missing mode fails the turn rather than running under another | session resume | HTTP MCP | npm | refuses second prompt mid-turn, so no steering |
| DeepSeek (dsh) | ACP profile | named models share one effort option; model then effort applied from updated config | optional key; own stored creds | Sandbox preset via env var; session keeps the sandbox it was created with, so a mode change starts a fresh session | ACP | HTTP MCP | manual | |
| Hermes Agent | `hermes acp` | Default plus advertised options; custom ids accepted | error code mapped to "run setup" | ask/auto/plan/full names | ACP | HTTP MCP | manual | |
| ZCode | Private `app-server` NDJSON on stdio; create, subscribe, send; permissions as reverse requests | Throwaway session; catalogue in the create snapshot; model and thought level set then verified against returned snapshot (refusal fails the turn) | sign-in message on error | build/edit/plan/yolo session modes; answers with the offered allow/deny object | deferred persistence so captures leave no history; resume by saved id | none | manual | Unknown events ignored, unknown reverse requests answered "method not found"; protocol pinned per recorded version |
| Muse Code | `muse serve` JSON-RPC (client-minted UUIDv7 command ids required) | `model/list` on a memory-only host; effort variants; skills list | error kind authRequired | Approval mode on the wire plus sandbox posture by process flags (plan disables write and shell; full disables sandbox); engine's own LLM judge cannot be turned off | session start or resume then set approval and model (resume takes neither) | Per-session streamable HTTP MCP | manual | Turn ends at the turn-completed message, not the earlier foreground-completed one; launcher disables its own device login so it cannot hang on pipes; steer ack and echo can arrive in either order |
| Pi / omp | RPC mode over JSONL; omp is a fork | `--list`-style discovery skipping Pi-only flags for omp | own CLI | Engine has none, so a bridge extension in the engine enforces the four modes; omp launched with its own approvals off | Pi session id, omp `--resume` | App tools through a loopback bridge extension; in plan mode only read-only app tools stay | npm / bun | omp ends runs with a different message; registers tools as essential so they are not hidden |

Protocol traps worth remembering (all from PandaCode's own notes):
1. Re-state permission mode on every turn and on resume; a saved higher mode otherwise survives.
2. Never trust a vendor's mode label; read engine source or recorded frames, then rename for the user.
3. A mode the server stops advertising must fail the turn, not fall back.
4. Config options come back changed per model; apply mode, then model, then effort, waiting for each acknowledgement before the prompt.
5. Discovery must not create persistent sessions; where it must, delete them.
6. Child-agent events share the parent's connection on Codex and Claude; filter by thread/turn/parent id or the parent turn ends early.
7. Idempotent completion: final snapshot supplies only a missing suffix whose prefix matches what was streamed.
8. Environment variable names set by other tools (nested session marker, vendor desktop terminal marker) change engine behaviour; strip them.
9. Config precedence differs per vendor: settings-file env can override process env; set source lists empty when an isolated relay is needed.
10. Version gates matter: a flag unknown to an older CLI fails the turn; run no silent fallback to another policy.

Speed/"fast": only Codex (catalog tier) and, sometimes, Devin (config option). Nothing for Claude. Our policy never auto-selects it; offering it as a user choice from the catalog is consistent.

---

## 3. Platform specifics

### Windows (all solutions found)
Process spawning and shims (code: `providers/launch.rs`):
- Batch shims (`.cmd`/`.bat`) are never run through the command shell. PandaCode maps the shim name to the npm package it belongs to, finds the package's declared entry point, and launches Node (or the `.exe`) directly with the entry as its first argument. Reason: paths, JSON and model names would otherwise become shell syntax. Unknown batch files are refused with "select the native executable".
- Three shim shapes handled: package folder beside the shim; pnpm global shims that point into a hashed store (accepted only when the target is exactly the entry the package itself declares, so a shim never chooses what runs); standalone installers whose launcher is a sibling Node script started by the node on PATH. The resolved script is rejected if it is a shell host (cmd, PowerShell, wscript and similar).
- Node is taken from beside the shim first, else from searched folders (including nvm-windows, fnm under AppData, Volta, etc.).
- Extension search order for bare names: `.exe`, `.com`, `.cmd`, `.bat`, bare.
- Child consoles hidden with the no-window creation flag on every stdio adapter and helper.
- Path form: Rust canonical paths carry the `\\?\` prefix. Node and ACP servers can read that as part of the drive, and Git rewrites it into an invalid path when creating a linked worktree. PandaCode strips the prefix only for ordinary drive and UNC forms, refusing reserved device names (CON, NUL, COM1-9 and superscript variants), trailing dots/spaces and anything over the legacy length limit; stored paths stay canonical. A simplifying helper is applied right before Git worktree calls.
- Home and PATH come from the real profile and AppData folders, `USERPROFILE` before `HOME`, plus Windows PowerShell directory under System32 so scripts can find it.

Job objects and process-tree kill (code: `providers/windows_job.rs`, `workspace.rs`, `terminal.rs`):
- Each spawned engine is assigned right after spawn to a job object with kill-on-close; closing the job kills descendants. A registry keyed by pid keeps jobs alive while the tree runs and drops finished ones on each new registration. Assignment failure is non-fatal: fallback is `taskkill /T /F`, also with the no-window flag.
- Git commands spawned for bounded runs each get their own tree kill on timeout (job or taskkill) so hooks die too.
- On forced app exit every registered pid is killed first, because Rust destructors are skipped.
- Terminal drop order matters: terminate the job tree *before* closing ConPTY, because the pseudo console close can block on a surviving process holding the output pipe.
- A real test spawns a parent and a grandchild and asserts both die when the job drops.

ConPTY and shells (code: `terminal.rs`, doc: platform-support):
- Terminal uses portable-pty (ConPTY, hence Windows 10 1809 minimum).
- Shell choice on Windows ignores the `SHELL` variable (Git Bash exports a POSIX path that ConPTY cannot execute): prefers a native `pwsh` then `powershell` that is a real `.exe`/`.com`, else `ComSpec` or `cmd.exe` with the no-autorun flag. Flags are argv, never a command string.
- ConPTY's own console host process is excluded from "user jobs" when counting what keeps a terminal alive.

Other Windows items:
- Listening-server discovery uses a bounded PowerShell query returning JSON (address, port, process), deduplicated and restricted to loopback; tests cover parsing.
- File snapshots (turn changes): open without following reparse points, reject reparse-point files, then check the final path of the opened handle, so a worker swapping an ancestor for a junction cannot redirect a read. Case aliasing is treated as one file on macOS and Windows.
- Secrets in Credential Manager; no prompts after updates.
- Link opening via the URL protocol handler and reveal via `explorer /select`.
- WebView2: Evergreen runtime; installer downloads the bootstrapper silently only if absent. `webview2-com` is used to capture the embedded browser pane as PNG through the native API. Linux and Windows deps are conditional so Mac builds don't carry them.
- Installer: per-user NSIS, static C runtime link (no redistributable needed), x64 and native arm64 runners; update install mode passive.
- Signing: not wired. SmartScreen warning documented ("More info, Run anyway"). No Authenticode. We should not assume a PandaCode answer here.
- Packaged-app smoke on a disposable GitHub-hosted Windows runner only (refuses self-hosted): silent install with literal NSIS args (`/D` last, unquoted), isolated HOME/USERPROFILE/APPDATA/LOCALAPPDATA, secrets stripped from the environment, asserts exactly one app exe, runs it, checks it stays alive for a fixed time. Docs say plainly that survival proves nothing about rendering.
- Not covered by CI: Rust tests run on Linux only (inferred from ci.yml); Windows tests exist (`windows_job`, launch shim tests use a `windows: bool` parameter so Windows logic is unit-tested on any OS - a technique worth copying in spirit).

### macOS
- GUI launches start with a minimal PATH. PandaCode does *not* source the login shell. It widens its own PATH once at startup from fixed locations (Homebrew arm and Intel, `~/.local/bin`, cargo, bun, etc.), version-manager default or newest versions (fnm, nvm, mise, asdf), and the npm global prefix found by reading config (env, `~/.npmrc`) or the real node binary's prefix, without running npm. Existing entries keep order; missing ones are appended. A dedicated integration-test binary asserts this so the process-wide change cannot leak into other tests.
- TCC: normal launch of an unsigned app hit permission errors opening a project under Documents while a parent-inherited launch worked. Documented workaround: choose folder through Browse, or grant under Files & Folders, then Retry. Because ad-hoc signatures change every release, grants and keychain ACLs reset at each update; PandaCode re-signs its own bundle with a per-machine self-signed identity kept in its own keychain, so grants persist. A Developer ID signature is left alone. (Evaluate carefully: it modifies our own bundle, not the target or engine config, so it does not break rule 4, but it is security-sensitive.)
- Keychain: abandoned for app secrets (unsigned builds make each item pin to one build, so every update prompted). Legacy items migrated once via attribute-only query. Usage keychain reads run in a short child with UI disabled and parent identity check. **Conflicts with rule 1 for engine tokens**, see section 7.
- Notarization: build script requires notarization credentials when a Developer ID is used, verifies with stapler and spctl, retries stapling because the ticket can lag. Unsigned builds: ad-hoc signature, release notes tell users to clear the quarantine attribute; an npx installer verifies the update signature and signs locally. DMG window styling needs Automation access, so CI skips it.
- Minimum OS 12; ONNX router needs 13.4 (not relevant).
- Tray/menu bar and global shortcut plugins used; Linux global shortcut limited to X11.

### Linux (for completeness)
AppImage environment pollution (library and runtime paths pointing into the mount) is stripped from every spawn of an external tool; rebuilds the AppImage without bundled Wayland libs, forces X11 by default but lets the user override.

---

## 4. Reliability techniques we may lack

Checked against our crates (process.rs already has job objects, taskkill fallback and npm `.cmd` shim following; CI already has macOS-14 and Windows-2022; startup recovery with `interrupted`, owner epochs, SessionLost and handoff exist per architecture.md).

| Technique | PandaCode behaviour | Our state (from docs/architecture.md and a grep of crates) |
|---|---|---|
| Child environment sanitising | Strip AppImage vars; strip nested-session marker; strip vendor desktop markers; optional "prefer saved login" scrub of inherited credential variables and endpoint overrides; layered env (inherited, global, per-engine, engine auth, per-connection) with names-only IPC and limits (64 vars, 4096 chars) | No `env_remove` or `env_clear` found in our crates. Gap. |
| GUI PATH | Fixed ordered search and widen-once at startup, no shell sourcing | Parity P2 open; terminal uses `SHELL` only. Gap. |
| Shim breadth | pnpm, standalone sibling launcher, shell-host refusal, node discovery | We follow the first quoted `%dp0%` path in a `.cmd`; other shim shapes refused. Partial. |
| Windows path hygiene | `\\?\` simplification for Git/Node; reserved-name checks; reparse-aware reads | No path simplification (no dunce-style call) found. Gap. |
| Terminal shell on Windows | Native PowerShell first; ignore `SHELL` | We use ComSpec (cmd.exe) on Windows. Gap (minor). |
| Terminal teardown order | Kill job tree before closing ConPTY | Unverified in our terminal.rs. Check. |
| Stop vs restart | `stop_requested` saved before signalling; startup interruption flag `restart_interrupted` only when the user did not stop; stale tool rows annotated "interrupted before result"; wake claims given back if the woken turn never reached the agent | We have startup `interrupted` and expiry; no equivalent of the user-stop-before-signal marker described. Partial. |
| Context recovery | One-time handoff row in the same transaction that clears the native session id; acknowledged only after a successful persisted turn with a new native id; startup failure, cancel, restart keep it pending; limits 200 messages and 64 KiB with disclosure; commands that cannot carry a historical prompt are refused while pending; legacy repair migration | We have SessionLost rebuild (16,000 chars) and handoff on rewind/fork/switch. Ack semantics and the "catalogue change forces new thread" case (Codex tools) not documented. Partial. |
| Conversation import | Reads Claude and Codex native logs, creates a task in the folder's project, resumes the same agent session, sends nothing to a model; dedupes already-imported; summaries cached per file stat | Parity K36 open. |
| Fork and rewind | Fork copies the stored prefix in one SQLite snapshot (not display-truncated); can snapshot a running source; edit-prompt = fork before the message and refill composer; files not rewound | Fork/rewind exist with checkpoints. Edit-and-refill UX row missing. |
| Tool trace | Pure, escaped renderer producing sentence rows with kind icons; groups of at most 5 calls; live preview bounded to 30 entries; results as cards; bounded snapshots (4 KiB input, 8 KiB output, 64 per adapter); a gallery HTML for visual review | Parity C rows partial. Bounded-snapshot rule worth adopting at the contract. |
| Streaming coalescing | 33 ms / 8 KiB buffer, deltas only (T3 sends whole entities every 50 ms; PandaCode's own benchmark says this is ~3x less main-thread time) | Unknown for ours (SSE log). Measure. |
| Discovery hygiene | No prompts, bounded bytes/time, process-group cleanup, 5-min cache, never overwrite a known catalogue with a default-only result, invalidate on settings save | Partly (5-min cache documented). |
| Credential-free login probes | See table; startup diagnostics strip ANSI and drop any line that looks like a credential before showing the cause | Partial; no redaction layer documented. |
| MCP call budgets | Every app tool answers within 45 s (engines time out at 60 s); approval waits capped at 240 s; call abandoned if the client disconnects so a late Approve runs nothing; body 160 KiB, headers 8 KiB, result 128 KiB | Not documented for orbynd MCP. Gap. |
| Steering reporting | pending, delivered, failed per steer id; failed ones requeued; engines without mid-turn input hold for next turn | Our `/steer` returns 422 if unsupported; delivered/failed events not described. Partial. |
| Watchdog | Silent-turn timeout tied to longest tool timeout; ignores waits on humans | None documented. Gap. |
| Model health | Failing model paused per engine with cooldown, persisted; harness pauses when two models pause; failover to the same model on another engine | Parity I43 fallback model only. |
| Warm next-turn process | Skips ~1.4 s CLI startup; strict adoption key | Not present. Optional. |
| Tests | (a) Recorded real frames per engine version back parser tests; (b) ignored live smoke test per installed CLI that reads catalogues without prompting; (c) opt-in two-turn resume smoke with an env switch naming the engine; (d) protocol tests for interleaved children, replay dedupe, bounds; (e) `windows: bool` parameters so Windows logic runs on any OS; (f) concurrency tests for admission, approvals isolated by run; (g) browser UI suite against fixture mode, plus WebKit run; (h) palette contrast across recorded real themes; (i) schema-version-constant test | We have tested-versions manifest and runs tests. Recorded-frame and ignored-live-smoke discipline should be written into driver tests. |
| Benchmarks | Seeded 50 KB Markdown reply in 25-byte deltas every 16 ms, replayed in a fresh Chrome process 9 times alternating order, with idle baseline; CDP task time, heap, mutation counts, rendered-structure parity check; raw JSON keeps machine, commits | Useful and unusually relevant: it benchmarks against T3 Code. |
| CI matrix | ubuntu: typecheck, unit tests, build, site build; ubuntu-22.04: cargo test lib + Clippy deny warnings; macos: ONNX parity job; actions pinned by full commit SHA; concurrency cancel-in-progress | Ours has macOS and Windows; add pinned SHAs if not already. |
| Release process | Version script updates all manifests; tag must match config; notes file required and non-empty; manual run without publish keeps artifacts 14 days; per-asset SHA-256 files; SBOM (CycloneDX) for installers and lockfiles plus a coverage report where an empty inventory is "incomplete", never "clean"; scanner versions pinned by checksum; Homebrew tap that self-updates; npx installer verifying the update signature | Unknown for ours. |
| Update flow | Tauri updater with embedded public key; modes Automatic (install only when no agent runs and user idle 2 minutes), Notify, Off; Linux non-AppImage reports only; lost private key means reinstall, so keep it offline; agent CLI updates only via recognised installer receipt, version re-read afterward because exit code 0 is not proof; never run an updater just to learn if one exists; Windows file locks can require manual action | Architecture rules 9 plus `--parent-stdin` protocol cover most. Idle-gating and re-verify-version are the additions. |
| Privacy | One switch turns on each vendor's own telemetry opt-outs for every spawned engine (runs, spares, consoles, discovery), with a table showing off / manual / unknown per engine; no config files edited | Parity K rows mention telemetry in other senses. |
| Network disclosure | README table of every automatic request, host and cadence; rule that any new automatic request must be added to it | Not present. |

---

## 5. Proposed new rows for docs/parity.md

Current section maxima: A74 B60 C36 D28 E18 F64 G11 H44 I53 J25 K55 L51 M16 N22 O26 P27 Q40 R14.
Source paths below are inside the PandaCode reference checkout (not ours). `beyond T3` = outside T3's feature set. L and Q are out of scope; no rows added there.

```
- [ ] A75 Open thread holds its section: the thread you are in never jumps between Active, Finished and Settled until you leave it; a held thread that starts running becomes Active | src/sidebar-sections.ts | w d | S | beyond T3
- [ ] A76 Edit sent prompt: forks before that message into a new thread in the same folder and puts the text back in its composer; files are not rewound | docs/rewind.md | w d s | S | beyond T3
- [ ] B61 Steer delivery states: each mid-turn message reports pending, delivered or failed by id; a failed one returns to the queue; engines with no mid-turn input hold it for the next turn | src-tauri/src/providers/steering.rs | w d s | M
- [ ] B62 Response style packs: per-thread output-saving packs added as one folded block only when the selection changes and every N messages | src/token-saver.ts | w d | M | beyond T3
- [ ] B63 Workflow recipes: local step lists (prompt, slash command, check, approval) with a dry run showing supported, fallback or blocked per engine; run goes through the normal queue | docs/recipes.md | w d s | M | beyond T3
- [ ] B64 Turn checks: optional run of the checkout's own quick check after a clean turn; a failure queues one editable fix message, never a loop; needs trusted folder | src-tauri/src/checks.rs | w d s | M | beyond T3
- [ ] B65 Prompt context chips: documents and folders become context blocks; sent blocks render as read-only chips that open the file, reveal the path or show the text | src/message-attachments.ts | w d | M | beyond T3
- [ ] C37 Sentence tool trace: each tool call is a verb-object row with kind icon; calls group in fives with a count summary; live view bounded to 30 rows; turn folds to a summary at the end | src/tool-trace.ts | w d | L
- [ ] C38 Bounded tool snapshots: input preview 4 KiB, output preview 8 KiB, UTF-8-safe truncation notice, 64 snapshots per run | docs/providers.md | s | S
- [ ] C39 Delta coalescing: text deltas merged for 33 ms or 8 KiB before sending, only new text per event | src-tauri/src/providers.rs | s | S
- [ ] C40 Rich question content: agent questions render Markdown, charts and sanitised SVG or static HTML in an isolated root; remote images become links | src/rich-markdown.ts | w d | M | beyond T3
- [ ] D29 Document viewer: PDF, Word and spreadsheet files open in a tab; zips size-checked before parsing; Word rendered in an isolated root | src/office-viewer.ts | w d | L | beyond T3
- [ ] D30 Mockup sketcher: draw a sketch and attach it as an image | src/sketch.ts | w d | M | beyond T3
- [ ] E19 Write-attributed changes: a turn's change list holds only files the thread declared (begin and complete handshake) or the engine reported, frozen at tool completion; never inferred from status; caps 200 paths, 1 MiB per file, 32 MiB per turn | docs/turn-changes.md | s w | L | beyond T3
- [ ] F65 Windows Git paths: strip the extended-length prefix before worktree creation; keep stored paths canonical | src-tauri/src/workspace.rs | s | S
- [ ] F66 Jujutsu checkouts: status and change panel for non-colocated repositories | docs/jj.md | s w | L | beyond T3
- [ ] G12 Windows shell choice: native PowerShell executable first, then ComSpec; ignore a POSIX `SHELL`; flags as arguments | src-tauri/src/terminal.rs | s | S
- [ ] G13 Terminal close order: end the process tree before closing the pseudo console so the close cannot hang | src-tauri/src/terminal.rs | s | S
- [ ] G14 Engine console: open the engine's own terminal UI resumed on the thread's session with the same model and mode, where the engine supports it | src-tauri/src/terminal.rs | w d s | M | beyond T3
- [ ] H45 Windows listener list: loopback listeners with process names from a bounded PowerShell query | src-tauri/src/local_servers.rs | s | S
- [ ] I54 Child environment hygiene: remove AppImage variables, the nested-session marker and vendor desktop markers from every engine spawn | src-tauri/src/child_env.rs | s | S
- [ ] I55 Prefer saved login: scrub inherited credential and endpoint variables so the engine uses its own login; report only variable names and endpoint origin | src-tauri/src/providers/claude_auth.rs | s w | M | beyond T3
- [ ] I56 Login probe without secrets: run the engine's own status command with settings sources empty, time and size bounded, output wiped; map to signed in, not signed in, other credentials, unknown | src-tauri/src/providers/claude_auth.rs | s | S
- [ ] I57 Agent telemetry switch: one setting applies each engine's own telemetry opt-outs to every spawn; coverage table shows off, manual or unknown per engine | src-tauri/src/providers/privacy.rs | s w d | M | beyond T3
- [ ] I58 Codex fast tier from catalog: offered only when the model list names the tier | src-tauri/src/command_operations.rs | s w | S
- [ ] I59 Discovery without leftovers: engines that report per-model options only after a switch are probed in throwaway sessions that are deleted afterwards | src-tauri/src/providers/devin.rs | s | M
- [ ] I60 Model health pauses: a failing model is paused with a cooldown that survives restart; same model on another engine is offered as failover; Settings can allow it now | src-tauri/src/model_health.rs | s w | M | beyond T3
- [ ] I61 Warm next turn: start the next Claude process in the background and adopt it only when every launch input matches | src-tauri/src/providers/warm.rs | s | M | beyond T3
- [ ] I62 Extra engines: Kimi Code, DeepSeek, Command Code, Cline, Kilo Code, Hermes Agent and ZCode with their documented quirks (Cline effort by flag, ZCode private protocol) | docs/providers.md | s | L | beyond T3
- [ ] J26 Resume at reset: when an engine reports a reset time, offer to send Continue at that time; overdue resumes recovered at startup before queued messages | src-tauri/src/providers/limits.rs | s w | M | beyond T3
- [ ] K56 Capability inventory: read-only list of each engine's commands, MCP server names, hook event names, plugin names and skill folders; no secrets, bodies or absolute config paths | docs/capabilities.md | w d s | M | beyond T3
- [ ] K57 Network disclosure: Settings lists every automatic outbound request with host and cadence | README.md | w d | S | beyond T3
- [ ] M17 After-thread trigger: a schedule that fires when another thread finishes, optionally only on success; run history capped at 200 per thread | docs/schedules.md | s w | M
- [ ] M18 Silence watchdog: a delegated run with no event for twice the longest tool timeout is stopped; waits on approvals and questions do not count | src-tauri/src/architect/watchdog.rs | s | S
- [ ] M19 Interrupted marking: a Stop is saved before the signal so a quit after it is not counted as restart interruption; unfinished tool rows get an interrupted note | src-tauri/src/storage.rs | s | M
- [ ] N23 Tool call budgets: app tools answer within 45 s, approval waits cap at 240 s, calls end when the client disconnects, bodies and results size-capped | src-tauri/src/providers/mcp_host.rs | s | M
- [ ] O27 Render benchmark: replay a seeded 50 KB reply in fixed deltas into this UI and the reference UI in fresh browsers, record main-thread time, heap and mutations | bench/t3-compare/README.md | c | M | beyond T3
- [ ] P28 Menu-bar popover: icon with running count; popover lists running, needs you, finished unseen and plan usage read on open | src-tauri/src/tray.rs | d | L | beyond T3
- [ ] P29 Quick launcher: global shortcut opens a small window for new and running threads; manual open when shortcut registration fails | src-tauri/src/overlay.rs | d | L | beyond T3
- [ ] P30 Idle-gated update install: install and restart only with no run active and two idle minutes; modes Automatic, Notify, Off | src/app-updates-policy.ts | d | S
- [ ] P31 Deterministic tool search path: ordered install folders, version-manager defaults and npm prefix read from config, added once at startup without sourcing a shell | src-tauri/src/providers/launch.rs | d s | M | alternative to P2
- [ ] P32 Windows installer settings: per-user install, silent WebView2 bootstrapper, static C runtime, native arm64 build | scripts/release/build.mjs | d | M
- [ ] P33 Packaged-app startup smoke: install the built package on a disposable hosted runner with isolated profile folders and no secrets, and check it stays alive | scripts/release/ci-startup-smoke.mjs | d c | M
- [ ] P34 Release evidence: per-asset checksums, installer and lockfile SBOMs, coverage report where an empty scan reads "incomplete", actions pinned by commit | docs/releasing.md | c | M
- [ ] P35 Notarization check: require credentials for Developer ID builds, verify with stapler and spctl, retry stapling | scripts/release/build.mjs | d c | S
```

Notes on rows:
- A75, B61, E19, P30, P31 overlap partly with existing rows (A20/A23, B11-B13, checkpoints, P3, P2). They add a specific rule, so I wrote them as separate rows; merge if you prefer.
- I62 is "beyond T3" only for engines T3 lacks (Kimi, DeepSeek, Command Code, Cline, Kilo, Hermes, ZCode). Others in PandaCode already map to I17-I34.
- Bots, cloud agents, VMs, model-routing ONNX, remote machine orchestration, design canvas, moodboards, GitHub hub, Jev, mobile, relay were deliberately not turned into rows (scope or hard-rule conflict).

---

## 6. Top 15 actions for our product (ranked)

Owning paths are in `repo/orbyn-engineering-app`.

1. **Child environment policy in the one spawn function.** Owner: `crates/orbyn-core/src/process.rs` (`engine_command`). Remove the nested-session marker and AppImage/vendor-desktop markers; add an optional prefer-saved-login scrub; keep a names-only layered env. Why: we found no env removal anywhere in our crates, and the nested-session variable silently changes Claude behaviour when orbynd is started from a Claude session (likely during our own agent-driven development).
2. **Deterministic tool search path and fuller shim handling.** Owners: `process.rs` (`find_on_path`, shim resolution), `desktop/src-tauri/src/main.rs` (set PATH at startup), parity P2/P31. Add fixed folders, version-manager dirs, npm prefix from config, pnpm and sibling-launcher shims, shell-host refusal. Why: Finder/Dock and Start-menu launches find no Homebrew, nvm or pnpm tools; today our shim parser accepts only one shape.
3. **Windows path and shell hygiene.** Owners: `crates/orbyn-core/src/git.rs`/`workspace.rs` (strip extended prefix before Git and engine cwd), `terminal.rs` (PowerShell first, teardown order), `files.rs` (reparse-point-safe reads), `preview.rs` (listener query). Why: each is a documented real failure; none needs new dependencies beyond a path-simplify helper.
4. **Packaged-app startup smoke plus installer settings.** Owners: `.github/workflows/*`, `desktop/src-tauri/tauri.conf.json`. Per-user installer, WebView2 bootstrapper, static CRT, disposable runner, isolated profile dirs, secrets removed. Why: we test the core on Windows already but never prove the shell starts orbynd from an installed package.
5. **Fail-closed engine configuration and recorded-frame tests.** Owners: `crates/orbyn-core/src/driver/{acp,codex,claude}.rs`, `engines/tested-versions.json`. Re-state mode on resume, wait for each config acknowledgement before the prompt, fail if an advertised mode disappears; keep recorded real frames per version and ignored live catalogue smoke tests. Why: the largest class of silent policy downgrades in PandaCode's notes.
6. **Credential-free login probes and diagnostics redaction.** Owners: `engines/probe.rs`, `driver/pipes.rs`, `error.rs`. Use the engines' own status commands with bounds, map first-turn auth errors to "run X login", strip ANSI and credential-looking lines from startup errors. Why: supports rule 1 while giving users an actionable state; our UI otherwise shows raw noise.
7. **Stop-before-signal and restart-interrupted markers.** Owners: `crates/orbyn-core/src/store/runs.rs`, `store/migrations.rs`, `runs.rs`. Persist a stop request before signalling, distinguish restart interruption, annotate unfinished tool rows, give back wake claims that never reached the agent. Why: avoids resuming work a user deliberately stopped and makes recovery trustworthy.
8. **Tool call budgets in the per-run MCP server.** Owner: `crates/orbyn-core/src/mcp.rs`, `mcp_tools.rs`. 45 s answer cap under the engines' 60 s timeout, approval wait cap, drop on client disconnect, size caps. Why: a hung gated tool otherwise strands a run in `awaiting_approval`.
9. **Context-recovery acknowledgement rules.** Owners: `composer.rs`, `runs.rs`, `store/queue.rs`. Insert handoff in the same transaction that drops the native session id; clear it only after a persisted turn; refuse commands that cannot carry it. Why: closes crash windows beyond our SessionLost path, including Codex tool-catalogue changes that force a new thread.
10. **Discovery bounds and cache rules.** Owners: `engines/mod.rs`, `engines/probe.rs`. Bytes, time, process-group cleanup, never replace a known catalogue with default-only, Codex fast tier only from catalogue, delete throwaway sessions. Why: model lists are on the hot path of every composer open.
11. **Idle-gated update install and version re-verification.** Owners: `crates/orbyn-core/src/updates/`, `desktop/src-tauri/src/main.rs`. Why: our rules forbid updating during a run; add "no input for two minutes" and read the version back after an engine updater exits.
12. **Bounded tool snapshots, delta coalescing and trace rows.** Owners: `crates/orbyn-contracts/src/lib.rs` (size limits), `web/src` timeline, SSE sink. Why: keeps the event log and DOM small; PandaCode's benchmark claims large main-thread savings against T3.
13. **Write-attributed change lists for shared checkouts.** Owner: `checkpoints.rs`. Declared-file begin/complete capture beside whole-checkout snapshots. Why: our restore refuses while another live thread shares the folder; attribution would let two threads coexist.
14. **Render benchmark against the reference UI.** New `bench/` or `web/tests/bench` plus a `docs` note. Why: we claim T3 parity; a seeded, repeatable streaming benchmark is the only way to catch a regression.
15. **Release evidence and network disclosure.** Owners: `.github/workflows/release.yml`, `docs/`. Checksums, SBOM with honest coverage, SHA-pinned actions, stapling retry, a table of every automatic outbound request. Why: cheap, and our update checks (every six hours) are exactly the sort of request users ask about.

---

## 7. Things not to copy (conflict with our hard rules or scope)

- Reads engine credentials for usage and quota: Claude OAuth usage endpoint with the local login, Kimi tokens, OpenCode auth, macOS Keychain helper, GLM keys. Violates rule 1. Our `UsageCenter` (local logs plus engine-reported limits) is the compliant design; PandaCode's local log ledger idea (dedupe by message/request id, running-total handling for Codex) is already in our architecture.
- Stores provider API keys and relays for GLM, MiMo, DeepSeek, Command Code (`secret_store.rs`). Rule 1 and parity `[auth-risk]` rows.
- Activates skills by writing into each harness's folders; writes `.pandacode/` recipes, design canvases and `pandacode-run.sh` into repositories. Rule 4.
- Defaults new tasks to Full access. Our default must stay supervised.
- Self-signing the app bundle to preserve TCC grants: only worth it if we ship unsigned builds; a Developer ID plus notarization is cleaner.
- Bots, cloud agents, VMs, remote orchestration, relay, mobile app, ONNX router: out of scope or hosted.
- Plain frontend with hand-kept IPC types: we already generate TypeScript from `orbyn-contracts`.

---

## 8. Not read or only skimmed

Read fully: AGENTS.md, README.md, docs/providers.md, approvals.md, platform-support.md, agent-updates.md, releasing.md, turn-changes.md, rewind.md, parity-plan.md, ipc.md (first 150 lines), bench/t3-compare/README.md, ci.yml.
Read in part (code): `providers/launch.rs`, `windows_job.rs`, `child_env.rs`, `claude_auth.rs`, `privacy.rs`, `diagnostics.rs`, `terminal.rs`, `workspace.rs`, `turn_changes.rs` (Windows read path only), `local_signing.rs` (header), `usage_keychain.rs` (header), `command_operations.rs` (fast tier), parts of `providers.rs` (Claude and Codex launch, kill, shutdown), `storage.rs` (interruption lines), `release.yml`/`build.mjs`/`ci-startup-smoke.mjs` (greps).
Skimmed only (first lines or grep): validation.md (77 KB, headings and macOS section), remote-access.md, bots.md, cloud-agents.md, machine-orchestration.md, jj.md, jev.md, model-routing.md, schedules.md, slash-commands.md, capabilities.md, recipes.md, skills-library.md.
Not read: `acp.rs` and per-engine files (`muse.rs`, `zcode.rs`, `pi.rs`, `devin.rs`) beyond docs, `conversation_import` and `context_recovery` code, `architect*`, `bots*`, `cloud*`, `vm*`, `remote*`, `panda_router*`, `simulator*`, `jev*`, frontend `src/` beyond headers, `mobile/`, `relay/`, `website/`, `packages/`, `tests/` bodies, `.github/workflows/release.yml` beyond greps, `mcp_host.rs` beyond header.
Not verified by running anything: all behaviours are from docs and source reading. Windows claims are from source and docs only; the project itself says Windows and Linux are previews with incomplete interactive validation.
