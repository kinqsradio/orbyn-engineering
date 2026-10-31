/** mock-fixture: deterministic data for the dev server and tests. Never shipped. */
import type {
  Approval,
  EngineStatus,
  FileDiff,
  Project,
  Run,
  RunState,
  ServerInfo,
  Thread,
  WireThreadEvent,
  AgUiEvent,
  JsonValue,
  ServerSettings,
  UpdateStatus,
  WorkspaceStatus,
} from "../src/api/types.ts";

/** Fixed under test. In the dev server, "now" at startup, so ages read realistically. */
export const T0 = process.env.VITEST ? Date.UTC(2026, 9, 31, 9, 0, 0) : Date.now();
export const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

export const info: ServerInfo = { version: "0.1.0", remote: false, platform: "macos" };

export const projects: Project[] = [
  {
    id: "p-app",
    name: "orbyn-engineering-app",
    path: "/Users/dev/code/orbyn-engineering-app",
    trusted: true,
    is_git: true,
    managed: false,
    scratch: false,
    created_at: iso(-86400 * 3),
  },
  {
    id: "p-site",
    name: "marketing-site",
    path: "/Users/dev/code/marketing-site",
    trusted: true,
    is_git: true,
    managed: false,
    scratch: false,
    created_at: iso(-86400 * 2),
  },
  {
    id: "p-new",
    name: "vendor-sdk-with-a-rather-long-repository-name-for-layout",
    path: "/Users/dev/code/clients/acme/vendor-sdk-with-a-rather-long-repository-name-for-layout",
    trusted: false,
    is_git: false,
    managed: false,
    scratch: false,
    created_at: iso(-3600),
  },
];

const caps = (over: Partial<EngineStatus["capabilities"]> = {}): EngineStatus["capabilities"] => ({
  streaming: true,
  goal_control: false,
  approvals: true,
  resume: true,
  mcp: true,
  sandbox: true,
  managed: true,
  skill_delivery: ["native_plugin", "mcp_skill_server"],
  ...over,
});

export const engines: EngineStatus[] = [
  {
    id: "claude",
    name: "Claude Code",
    tier: "native",
    capabilities: caps(),
    installed: true,
    path: "/Users/dev/.local/bin/claude",
    version: "2.1.14",
    auth: "logged_in",
    installer: "npm",
    latest: "2.1.20",
    support: "tested",
    update_command: "npm install -g @anthropic-ai/claude-code",
    manual_hint: null,
    sign_in_command: "claude auth login",
    updating: false,
    problem: null,
  },
  {
    id: "codex",
    name: "Codex",
    tier: "native",
    capabilities: caps({ skill_delivery: ["native_skill_root", "mcp_skill_server"] }),
    installed: true,
    path: "/opt/homebrew/bin/codex",
    version: "0.58.0",
    auth: "logged_out",
    installer: "homebrew",
    latest: "0.58.0",
    support: "untested",
    update_command: null,
    manual_hint: "Installed outside a package manager Orbyn can prove. Update it the way you installed it.",
    sign_in_command: "codex login",
    updating: false,
    problem: null,
  },
  {
    id: "gemini-acp",
    name: "Gemini CLI",
    tier: "acp",
    capabilities: caps({ resume: false, sandbox: false, skill_delivery: ["prompt_bootstrap"] }),
    installed: true,
    path: "/usr/local/bin/gemini",
    version: "0.9.2",
    auth: "unknown",
    installer: "unknown",
    latest: null,
    support: "below_minimum",
    update_command: null,
    manual_hint: "Update Gemini CLI with the tool you used to install it.",
    sign_in_command: null,
    updating: false,
    problem: "Version 0.9.2 is below the minimum Orbyn supports, 0.10.0.",
  },
  {
    id: "openbot",
    name: "OpenBot connector",
    tier: "agui",
    capabilities: caps({ mcp: false, sandbox: false, resume: false, skill_delivery: [] }),
    installed: true,
    path: "https://openbot.internal.example/agui",
    version: null,
    auth: "not_applicable",
    installer: "unknown",
    latest: null,
    support: "unknown",
    update_command: null,
    manual_hint: null,
    sign_in_command: null,
    updating: false,
    problem: null,
  },
  {
    id: "aider",
    name: "Aider (terminal)",
    tier: "terminal",
    capabilities: caps({
      streaming: false,
      approvals: false,
      resume: false,
      mcp: false,
      sandbox: false,
      managed: false,
      skill_delivery: [],
    }),
    installed: true,
    path: "/Users/dev/.local/bin/aider",
    version: "0.86.1",
    auth: "not_applicable",
    installer: "unknown",
    latest: null,
    support: "unknown",
    update_command: null,
    manual_hint: "Aider is a custom terminal engine. Update it yourself.",
    sign_in_command: null,
    updating: false,
    problem: null,
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    tier: "acp",
    capabilities: caps({ skill_delivery: [] }),
    installed: false,
    path: null,
    version: null,
    auth: "unknown",
    installer: "unknown",
    latest: null,
    support: "unknown",
    update_command: null,
    manual_hint: null,
    sign_in_command: null,
    updating: false,
    problem: "Not found on PATH.",
  },
];

const run = (id: string, threadId: string, state: RunState, offset: number, error?: string): Run => ({
  id,
  thread_id: threadId,
  state,
  error: error ?? null,
  started_at: iso(offset),
  ended_at: state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted" ? iso(offset + 90) : null,
});

const baseThread = (
  id: string,
  projectId: string,
  title: string,
  engine: string,
  offset: number,
  over: Partial<Thread> = {},
): Thread => ({
  id,
  project_id: projectId,
  title,
  engine,
  model: null,
  cwd: projects.find((p) => p.id === projectId)?.path ?? "/",
  worktree: null,
  skill_profile: null,
  active_run: null,
  last_run_state: null,
  scratch: false,
  created_at: iso(offset - 600),
  updated_at: iso(offset),
  lifecycle: lifecycle(),
  ...over,
});

const manyTitles = [
  "Tidy CI matrix",
  "Bump Rust toolchain",
  "Explain run fencing",
  "Trace audit writes",
  "Fix clippy warnings",
  "Port path handling to Windows",
  "Review migration order",
  "Write store tests",
  "Add policy glob tests",
  "Drop unused feature flags",
  "Update release notes",
  "Check WAL checkpointing",
  "Refactor engine probe",
  "Trim startup logs",
  "Rename skill profile field",
  "Add terminal resize test",
  "Document tray behaviour",
  "Investigate flaky SSE test",
  "Cut 0.1.0 candidate",
  "Remove dead fixtures",
  "Harden origin checks",
  "Sort audit by id",
  "Measure SQLite writes",
  "Clean worktree on delete",
];

export function threads(): Thread[] {
  const list: Thread[] = [
    baseThread("t-approval", "p-app", "Add approval timeout handling to the run owner", "claude", -300, {
      model: "claude-opus-5-5",
      active_run: run("r-approval", "t-approval", "awaiting_approval", -360),
      last_run_state: "awaiting_approval",
      worktree: {
        path: "/Users/dev/code/orbyn-engineering-app-wt/approval-timeout",
        branch: "approval-timeout",
        base: "main",
      },
    }),
    baseThread("t-done", "p-app", "Explain how the event log resumes", "claude", -1800, {
      last_run_state: "completed",
      model: "claude-opus-5-5",
    }),
    baseThread("t-failed", "p-app", "Upgrade tokio and fix the fallout", "codex", -3600, {
      last_run_state: "failed",
    }),
    baseThread("t-interrupted", "p-app", "Backfill audit rows after crash", "claude", -5400, {
      last_run_state: "interrupted",
    }),
    baseThread("t-unmanaged", "p-site", "Rewrite hero copy with aider", "aider", -7200, {
      last_run_state: "completed",
    }),
    baseThread("t-site-approval", "p-site", "Push a preview of the pricing page", "claude", -600, {
      active_run: run("r-site", "t-site-approval", "awaiting_approval", -640),
      last_run_state: "awaiting_approval",
    }),
    baseThread("t-empty", "p-site", "New thread", "claude", -9000),
  ];
  manyTitles.forEach((title, at) => {
    list.push(
      baseThread(`t-many-${at}`, "p-app", title, at % 3 === 0 ? "codex" : "claude", -10000 - at * 3600, {
        last_run_state: at % 7 === 3 ? "failed" : at % 11 === 5 ? "cancelled" : "completed",
      }),
    );
  });
  return list;
}

export function pendingApprovals(): Approval[] {
  return [
    {
      id: "ap-1",
      thread_id: "t-approval",
      run_id: "r-approval",
      kind: "command",
      summary: "Run the core test suite",
      detail: { command: "cargo test -p orbyn-core approval", cwd: "/Users/dev/code/orbyn-engineering-app-wt/approval-timeout" },
      state: "pending",
      decided_by: null,
      decided_at: null,
      created_at: iso(-320),
    },
    {
      id: "ap-2",
      thread_id: "t-approval",
      run_id: "r-approval",
      kind: "file_change",
      summary: "Edit 2 files in crates/orbyn-core",
      detail: { paths: ["crates/orbyn-core/src/approvals.rs", "crates/orbyn-core/src/run_owner.rs"] },
      state: "pending",
      decided_by: null,
      decided_at: null,
      created_at: iso(-300),
    },
    {
      id: "ap-3",
      thread_id: "t-site-approval",
      run_id: "r-site",
      kind: "network",
      summary: "Publish a preview deployment",
      detail: { url: "https://preview.example.com/deploy", method: "POST" },
      state: "pending",
      decided_by: null,
      decided_at: null,
      created_at: iso(-620),
    },
  ];
}

let seqCounter = 0;
const logOf = (threadId: string, runId: string, offset: number, events: AgUiEvent[]) =>
  events.map((event, at): WireThreadEvent => ({
    seq: 0,
    thread_id: threadId,
    run_id: runId,
    ts: iso(offset + at * 2),
    event: event,
  }));

export function sequence(events: WireThreadEvent[]): WireThreadEvent[] {
  seqCounter = 0;
  return events.map((event) => ({ ...event, seq: ++seqCounter }));
}

const user = (id: string, text: string): AgUiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];

const assistant = (id: string, text: string): AgUiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];

const reasoning = (id: string, text: string): AgUiEvent[] => [
  { type: "REASONING_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "REASONING_MESSAGE_END", messageId: id },
];

const tool = (id: string, name: string, args: string, result: string): AgUiEvent[] => [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: args },
  { type: "TOOL_CALL_END", toolCallId: id },
  { type: "TOOL_CALL_RESULT", messageId: `${id}-r`, toolCallId: id, content: result, role: "tool" },
];

const approvalSnapshot = (approval: Approval): AgUiEvent => ({
  type: "ACTIVITY_SNAPSHOT",
  messageId: `approval-${approval.id}`,
  activityType: "approval",
  content: approval as unknown as JsonValue,
  replace: true,
});

export const approvalEvent = approvalSnapshot;

const longAnswer = `The log is the source of truth. Every run event is stored in \`thread_events\` first, then broadcast, so delivery to a client is only a projection.

## How a client resumes

1. The client keeps the highest \`seq\` it has applied.
2. On reconnect it sends that value as \`Last-Event-ID\`.
3. The service replays everything after it, then follows live.

Nothing is lost, because a live subscriber is added **before** the replay query runs. Duplicates are possible at that seam, which is why the client drops a \`seq\` it has already seen.

\`\`\`rust
let mut live = bus.subscribe(thread_id);
let replay = store.events_after(thread_id, last_seq)?;
for event in replay.into_iter().chain(live.dedupe_after(last_seq)) {
    sink.send(event).await?;
}
\`\`\`

| Case | Result |
| --- | --- |
| Tab sleeps for an hour | Full replay from the last seq |
| Service restarts mid-run | Run becomes \`interrupted\`, stream replays to the end |
| Same event twice | Second copy is dropped by \`seq\` |

> A snapshot is not an event barrier. Only \`seq\` orders the log.

See [the AG-UI event spec](https://docs.ag-ui.com/concepts/events) for the event names. A very long path to check wrapping: \`crates/orbyn-core/src/runs/owner/fencing/compare_and_set_previous_state_transition.rs\`.
`;

const longToolOutput = Array.from(
  { length: 60 },
  (_, at) => `test approvals::tests::case_${String(at).padStart(3, "0")}_expires_open_approvals_when_the_driver_exits ... ok`,
).join("\n");

export function logs(): Record<string, WireThreadEvent[]> {
  const pending = pendingApprovals();
  const [ap1, ap2, ap3] = pending as [Approval, Approval, Approval];
  return {
    "t-approval": sequence(
      logOf("t-approval", "r-approval", -360, [
        { type: "RUN_STARTED", threadId: "t-approval", runId: "r-approval" },
        ...user("u1", "When the driver exits with an approval still open, the engine hangs. Expire it and send a denial."),
        ...reasoning("rs1", "The approval lifecycle says driver exit expires open approvals and the engine receives a denial. I should find where the driver exit is observed, then check whether the compare-and-set covers a late decision."),
        ...tool("c1", "Read", '{"path":"crates/orbyn-core/src/run_owner.rs"}', "pub struct RunOwner {\n    run_id: RunId,\n    epoch: OwnerEpoch,\n    ...\n}"),
        ...tool("c2", "Grep", '{"pattern":"expire_open","path":"crates/orbyn-core/src"}', "crates/orbyn-core/src/approvals.rs:88: pub fn expire_open(&self, run: RunId)"),
        {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "plan-1",
          activityType: "plan",
          content: { steps: [
            { title: "Find where driver exit is observed", status: "completed" },
            { title: "Expire open approvals on exit", status: "in_progress" },
            { title: "Send the denial to the engine", status: "pending" },
            { title: "Add a regression test", status: "pending" },
          ] },
          replace: true,
        },
        ...assistant("a1", "`expire_open` exists but is only called on cancel. I'll call it from the exit path and add a test. I need to run the tests and edit two files."),
        {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "diff-1",
          activityType: "diff",
          content: { files: [
            { path: "crates/orbyn-core/src/approvals.rs", additions: 14, deletions: 2 },
            { path: "crates/orbyn-core/src/run_owner.rs", additions: 6, deletions: 1 },
          ] },
          replace: true,
        },
        approvalSnapshot(ap1),
        approvalSnapshot(ap2),
      ]),
    ),
    "t-site-approval": sequence(
      logOf("t-site-approval", "r-site", -640, [
        { type: "RUN_STARTED", threadId: "t-site-approval", runId: "r-site" },
        ...user("u1", "Deploy a preview of the pricing page."),
        ...assistant("a1", "The build passed. Publishing the preview needs your approval."),
        approvalSnapshot(ap3),
      ]),
    ),
    "t-done": sequence([
      ...logOf("t-done", "r-done", -1900, [
        { type: "RUN_STARTED", threadId: "t-done", runId: "r-done" },
        ...user("u1", "Explain how the event log resumes after a reconnect. Include the edge cases."),
        ...reasoning("rs1", "I should read the architecture document first, then the store query."),
        ...tool("c1", "Read", '{"path":"docs/architecture.md"}', "## Event stream\n\nEvery run event is stored in `thread_events` with a per-thread `seq`, then broadcast."),
        ...tool("c2", "Bash", '{"command":"cargo test -p orbyn-core events"}', longToolOutput),
        ...assistant("a1", longAnswer),
        { type: "RUN_FINISHED", threadId: "t-done", runId: "r-done", outcome: { type: "success" } },
      ]),
    ]),
    "t-failed": sequence(
      logOf("t-failed", "r-failed", -3700, [
        { type: "RUN_STARTED", threadId: "t-failed", runId: "r-failed" },
        ...user("u1", "Upgrade tokio to the latest release and fix whatever breaks."),
        ...tool("c1", "Bash", '{"command":"cargo update -p tokio"}', "Updating tokio v1.40.0 -> v1.48.0"),
        { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "The update applied. Three call sites use a removed" },
        { type: "RUN_ERROR", message: "Codex exited unexpectedly with status 137.", code: "engine_exit" },
      ]),
    ),
    "t-interrupted": sequence(
      logOf("t-interrupted", "r-int", -5500, [
        { type: "RUN_STARTED", threadId: "t-interrupted", runId: "r-int" },
        ...user("u1", "Backfill the missing audit rows."),
        ...assistant("a1", "Audit rows are append-only, so a backfill has to be new rows that name the gap."),
      ]),
    ),
    "t-unmanaged": sequence(
      logOf("t-unmanaged", "r-un", -7300, [
        { type: "RUN_STARTED", threadId: "t-unmanaged", runId: "r-un" },
        ...user("u1", "Rewrite the hero copy to be shorter."),
        ...assistant("a1", "Done in the terminal session. See the Terminal panel for the output."),
        { type: "RUN_FINISHED", threadId: "t-unmanaged", runId: "r-un", outcome: { type: "success" } },
      ]),
    ),
  };
}

export const replyEvents = (runId: string, threadId: string, prompt: string, messageId: string): AgUiEvent[] => [
  { type: "RUN_STARTED", threadId, runId },
  ...user(`u-${messageId}`, prompt),
  ...reasoning(`r-${messageId}`, "This mock run replays a fixed script so the interface can be checked without an engine."),
  ...tool(`c-${messageId}`, "Read", '{"path":"README.md"}', "# orbyn-engineering-app"),
];

export const replyText =
  "This is a **scripted reply** from the mock service. It streams in small pieces so you can check `reconnect`, ordering and cancel.\n\n- The text arrives word by word\n- Each word has its own `seq`\n\nStop the run with Cancel, or wait for it to finish.";

export const diffs: Record<string, FileDiff[]> = {
  "t-approval": [
    {
      path: "crates/orbyn-core/src/approvals.rs",
      status: "modified",
      additions: 14,
      deletions: 2,
      patch: `@@ -84,8 +84,20 @@ impl Approvals {
     /// Expires every open approval for a run and denies the engine.
-    pub fn expire_open(&self, run: RunId) {
-        self.store.expire(run);
+    pub fn expire_open(&self, run: RunId) -> Result<usize> {
+        let expired = self.store.expire_pending(run)?;
+        for approval in &expired {
+            self.notify_denied(approval)?;
+        }
+        Ok(expired.len())
     }
+
+    fn notify_denied(&self, approval: &Approval) -> Result<()> {
+        self.waiters
+            .take(&approval.id)
+            .map_or(Ok(()), |waiter| waiter.send(Decision::Deny))
+    }
 
     pub fn decide(&self, id: &ApprovalId, allow: bool) -> Result<Outcome> {
         self.store.compare_and_set(id, Pending, allow.into())
`,
    },
    {
      path: "crates/orbyn-core/src/run_owner.rs",
      status: "modified",
      additions: 6,
      deletions: 1,
      patch: `@@ -212,7 +212,12 @@ impl RunOwner {
     async fn on_driver_exit(&mut self, status: ExitStatus) -> Result<()> {
-        self.finish(status.into()).await
+        // Open approvals must not outlive the process that asked.
+        self.approvals.expire_open(self.run_id)?;
+        self.finish(status.into()).await
     }
`,
    },
    {
      path: "crates/orbyn-core/tests/approval_expiry_with_a_long_test_file_name_to_check_row_wrapping.rs",
      status: "added",
      additions: 22,
      deletions: 0,
      patch: `@@ -0,0 +1,22 @@
+use orbyn_core::testing::harness;
+
+#[tokio::test]
+async fn driver_exit_expires_open_approvals() {
+    let run = harness().await.start_run().await;
+    let approval = run.request_approval("cargo test").await;
+    run.kill_driver().await;
+    assert_eq!(approval.state().await, ApprovalState::Expired);
+}
`,
    },
  ],
  "t-done": [],
};

export const fsTree: Record<string, { parent: string | null; entries: { name: string; is_git?: boolean }[] }> = {
  "/Users/dev": {
    parent: "/Users",
    entries: [{ name: "code" }, { name: "Documents" }, { name: "Downloads" }],
  },
  "/Users": { parent: "/", entries: [{ name: "dev" }, { name: "Shared" }] },
  "/": { parent: null, entries: [{ name: "Users" }, { name: "opt" }] },
  "/Users/dev/code": {
    parent: "/Users/dev",
    entries: [
      { name: "orbyn-engineering-app", is_git: true },
      { name: "marketing-site", is_git: true },
      { name: "payments-service", is_git: true },
      { name: "scratch" },
    ],
  },
};

/** The frozen comparison state: six recent threads, one working, 43 settled. */
export function referenceState(now: number) {
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const project = (id: string, name: string): Project => ({
    id,
    name,
    path: `/Users/dev/code/${name}`,
    trusted: true,
    is_git: true,
    managed: false,
    scratch: false,
    created_at: ago(864000),
  });
  const refProjects = [project("rp-1", "draftdesk"), project("rp-2", "orbitkit"), project("rp-3", "ledgerline")];
  const row = (
    id: string,
    projectId: string,
    title: string,
    branch: string,
    seconds: number,
    state: RunState = "completed",
  ): Thread => ({
    id,
    project_id: projectId,
    title,
    engine: "claude",
    model: "Opus 5.5",
    cwd: `/Users/dev/code/${projectId}`,
    worktree: { path: `/Users/dev/code/${projectId}-wt/${branch}`, branch, base: "main" },
    scratch: false,
    skill_profile: null,
    active_run: null,
    last_run_state: state,
    created_at: ago(seconds + 600),
    updated_at: ago(seconds),
  });
  const started = ago(25);
  const active: Thread = {
    ...row("rt-active", "rp-1", "Add Archive Export For Drafts", "main", 18, "running"),
    active_run: { id: "rr-active", thread_id: "rt-active", state: "running", error: null, started_at: started, ended_at: null },
  };
  const refThreads: Thread[] = [
    row("rt-1", "rp-1", "Offline drafts and sync status page do", "dev/offline-drafts-sync", 7 * 60),
    row("rt-2", "rp-1", "Require sign-in before exporting", "dev/require-sign-in-export", 29 * 60),
    row("rt-3", "rp-2", "Built-in Log Viewer Filters", "dev/log-viewer-filters", 3700),
    row("rt-4", "rp-3", "Reserve ledgerline on npm for pre-release", "main", 7300),
    row("rt-5", "rp-1", "Dark Theme Report Polish", "dev/dark-report", 4 * 3600),
    row("rt-6", "rp-3", "Disk and memory check", "dev/health", 90),
    active,
    ...Array.from({ length: 43 }, (_, at) =>
      row(`rt-old-${at}`, at % 2 ? "rp-2" : "rp-3", `Settled task ${at + 1}`, "main", 2 * 86400 + at * 3600),
    ),
  ];
  const tool = (id: string, name: string): AgUiEvent => ({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name });
  const at = (seconds: number, event: AgUiEvent, seq: number): WireThreadEvent => ({
    seq,
    thread_id: "rt-active",
    run_id: "rr-active",
    ts: ago(seconds),
    event,
  });
  const events: AgUiEvent[] = [
    { type: "RUN_STARTED", threadId: "rt-active", runId: "rr-active" },
    ...user("ru1", "Add archive export to drafts with 4 parallel tasks"),
    ...reasoning("rr1", "Four independent pieces can run at the same time."),
    tool("rc1", "Export button"),
    tool("rc2", "Archive API"),
    tool("rc3", "Archive tests"),
    tool("rc4", "Archive docs"),
    ...assistant("ra1", "Okay, starting the four export tasks."),
  ];
  const stamps = [45, 45, 45, 45, 39, 35, 30, 25, 23, 21, 19, 18, 18, 18];
  const log = events.map((event, index) => at(stamps[index] ?? 18, event, index + 1));
  return { projects: refProjects, threads: refThreads, logs: { "rt-active": log } as Record<string, WireThreadEvent[]> };
}

const rev = (seed: string) => `${seed}0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b`.slice(0, 40);

export const incoming = [
  { sha: rev("a1b2c3d"), subject: "Add statechart review guidance" },
  { sha: rev("d4e5f6a"), subject: "Tighten worktree cleanup rules" },
];

export function workspaceStatus(list: Project[], configured = true): WorkspaceStatus {
  return {
    configured,
    default_url: "https://example.com/orbyn/skills.git",
    library: configured
      ? {
          path: "/Users/dev/Library/Application Support/Orbyn/workspace",
          adopted: false,
          revision: rev("8ede3c4"),
          branch: "main",
          dirty: false,
          dirty_files: [],
          upstream: "origin/main",
          ahead: 0,
          behind: 2,
          previous_revision: rev("51fa223"),
          native_skills: true,
          problem: null,
        }
      : null,
    targets: list.map((project, at) => ({
      project_id: project.id,
      path: project.path,
      git_root: project.path,
      revision: rev(at === 0 ? "c16b80a" : "85a1821"),
      branch: "main",
      dirty: at === 1,
      worktrees:
        at === 0
          ? [
              {
                path: "/Users/dev/code/orbyn-engineering-app-wt/approval-timeout",
                branch: "approval-timeout",
                revision: rev("9c8d7e6"),
                dirty: false,
              },
            ]
          : [],
      instructions: ["AGENTS.md"],
      same_name_skills: at === 0 ? ["tdd"] : [],
      problem: null,
    })),
  };
}


export function updateStatus(behind: number): UpdateStatus {
  return {
    checked_at: new Date(T0 - 600_000).toISOString(),
    error: null,
    engines: [
      { id: "claude", current: "2.1.14", latest: "2.1.20", support: "tested", can_apply: true, blocked_reason: null },
      { id: "codex", current: "0.58.0", latest: "0.58.0", support: "untested", can_apply: false, blocked_reason: null },
    ],
    library: {
      current: rev("8ede3c4"),
      latest: rev("a1b2c3d"),
      behind,
      ahead: 0,
      dirty: false,
      incoming: behind > 0 ? incoming : [],
      can_apply: true,
      blocked_reason: null,
    },
    app: {
      current: "0.1.0",
      latest: "0.2.0",
      notes: "## Changes\n\n- Faster thread loading\n- Fixes terminal resize on Windows",
      mode: "desktop",
      can_apply: true,
      blocked_reason: null,
      unconfigured: false,
    },
  };
}

export const serverSettings = (): ServerSettings => ({
  auto_settle: { after_days: null, on_merge: false, keep_pull_requests: true },
  snooze_presets: [],
  title_instructions: null,
});

export const slashCommands = [
  { name: "review", description: "Review the current diff", source: "engine" },
  { name: "clear", description: "Start with a clean context", source: "engine" },
];

export const lifecycle = (): NonNullable<Thread["lifecycle"]> => ({
  pinned_at: null,
  archived_at: null,
  settled_at: null,
  snoozed_until: null,
  unread: false,
  auto_settle: null,
  position: 0,
  parent_thread_id: null,
  relation: null,
  permission_mode: "supervised",
  plan_mode: false,
});

export const usageEngines = () => [
  {
    engine: "claude",
    status: "scanned",
    files_scanned: 3,
    files_skipped: 0,
    models: [
      {
        model: "claude-sonnet",
        input_tokens: 120_000,
        output_tokens: 90_000,
        cache_read_tokens: 4_000_000,
        cache_write_tokens: 40_000,
        estimated_cost: 4.25,
      },
    ],
    days: [
      { date: iso(-86_400).slice(0, 10), tokens: 1_250_000 },
      { date: iso(0).slice(0, 10), tokens: 3_000_000 },
    ],
  },
];

const effort = {
  id: "effort",
  label: "Reasoning",
  values: [
    { id: "low", label: "Low", default: false },
    { id: "medium", label: "Medium", default: true },
    { id: "high", label: "High", default: false },
  ],
};

export const engineModels = (engine: string) => ({
  engine,
  source: "documented",
  error: null,
  checked_at: iso(0),
  models: [
    { id: "sonnet", label: "Claude Sonnet", description: null, is_default: true, custom: false, options: [effort] },
    { id: "opus", label: "Claude Opus", description: null, is_default: false, custom: false, options: [effort] },
    { id: "haiku", label: "Claude Haiku", description: null, is_default: false, custom: false, options: [] },
  ],
});
