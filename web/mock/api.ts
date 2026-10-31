/**
 * createMockApi: an in-memory service with the architecture's HTTP contract.
 * The dev-server plugin and the tests both drive it through `handle`.
 */
import type {
  AgUiEvent,
  ApplyAllResult,
  Approval,
  EngineStatus,
  Project,
  QueuedMessage,
  ServerSettings,
  Thread,
  UpdateStatus,
  UpdateThread,
  WireThreadEvent,
  WorkspaceStatus,
} from "../src/api/types.ts";
import * as fixtures from "./fixtures.ts";

export interface MockResponse {
  status: number;
  body?: unknown;
}

export type Scenario = "default" | "empty" | "first-run" | "remote" | "offline" | "reference";

type Subscriber = (event: WireThreadEvent) => void;

interface Failure {
  path: string;
  remaining: number;
  status: number;
  code: string;
  message: string;
}

export interface MockOptions {
  /** Delay between scripted events. Zero runs them on the next tick. */
  stepMs?: number;
}

const err = (status: number, code: string, message: string): MockResponse => ({
  status,
  body: { code, message },
});

export function createMockApi(options: MockOptions = {}) {
  const stepMs = options.stepMs ?? 90;

  let scenario: Scenario = "default";
  let signedIn = false;
  let projects: Project[] = [];
  let threads: Thread[] = [];
  let approvals: Approval[] = [];
  let logs: Record<string, WireThreadEvent[]> = {};
  let engines: EngineStatus[] = [];
  let managed: WorkspaceStatus = fixtures.workspaceStatus([]);
  let failNextSetup = false;
  let updates: UpdateStatus = fixtures.updateStatus(2);
  let settings: ServerSettings = fixtures.serverSettings();
  let failStep: string | null = null;
  let queued: QueuedMessage[] = [];
  let failures: Failure[] = [];
  let clones: unknown[] = [];
  let delayMs = 0;
  let idCounter = 0;
  const subscribers = new Map<string, Set<Subscriber>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
  const now = () => new Date(fixtures.T0 + idCounter * 1000).toISOString();

  function reset(next: Scenario = "default") {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    scenario = next;
    signedIn = false;
    idCounter = 0;
    failures = [];
    clones = [];
    delayMs = 0;
    const blank = next === "empty" || next === "first-run";
    projects = blank ? [] : structuredClone(fixtures.projects);
    threads = blank ? [] : fixtures.threads();
    approvals = blank ? [] : fixtures.pendingApprovals();
    logs = blank ? {} : fixtures.logs();
    if (next === "reference") {
      const state = fixtures.referenceState(Date.now());
      projects = state.projects;
      threads = state.threads;
      logs = state.logs;
      approvals = [];
    }
    managed = fixtures.workspaceStatus(projects);
    failNextSetup = false;
    updates = fixtures.updateStatus(2);
    settings = fixtures.serverSettings();
    failStep = null;
    if (next === "first-run") managed = fixtures.workspaceStatus([], false);
    engines = structuredClone(fixtures.engines);
  }
  reset();

  function append(threadId: string, runId: string | null, event: AgUiEvent): WireThreadEvent {
    const log = (logs[threadId] ??= []);
    const wire: WireThreadEvent = {
      seq: (log.at(-1)?.seq ?? 0) + 1,
      thread_id: threadId,
      run_id: runId,
      ts: new Date(fixtures.T0 + (log.length + 1) * 1000).toISOString(),
      event,
    };
    log.push(wire);
    for (const subscriber of subscribers.get(threadId) ?? []) subscriber(wire);
    return wire;
  }

  function setRun(threadId: string, patch: Partial<Thread>) {
    threads = threads.map((thread) =>
      thread.id === threadId ? { ...thread, ...patch, updated_at: now() } : thread,
    );
  }

  function play(steps: (() => void)[]) {
    let at = 0;
    const tick = () => {
      const step = steps[at];
      at += 1;
      if (!step) return;
      step();
      const timer = setTimeout(tick, stepMs);
      timers.add(timer);
    };
    const timer = setTimeout(tick, stepMs);
    timers.add(timer);
  }

  function startRun(thread: Thread, prompt: string): MockResponse {
    const project = projects.find((p) => p.id === thread.project_id);
    if (project && !project.trusted) {
      return err(403, "folder_untrusted", "Trust this folder before running an engine in it.");
    }
    if (thread.active_run) return err(409, "thread_busy", "This thread already has an active run.");
    const runId = nextId("run");
    const run = {
      id: runId,
      thread_id: thread.id,
      state: "running" as const,
      error: null,
      started_at: now(),
      ended_at: null,
    };
    setRun(thread.id, { active_run: run, last_run_state: "running" });
    const message = nextId("m");
    const live = () => threads.find((t) => t.id === thread.id)?.active_run?.id === runId;
    const steps: (() => void)[] = fixtures
      .replyEvents(runId, thread.id, prompt, message)
      .map((event) => () => {
        if (live()) append(thread.id, runId, event);
      });
    const answer = `a-${message}`;
    steps.push(() => {
      if (live()) append(thread.id, runId, { type: "TEXT_MESSAGE_START", messageId: answer, role: "assistant" });
    });
    for (const word of fixtures.replyText.match(/\S+\s*/g) ?? []) {
      steps.push(() => {
        if (live()) append(thread.id, runId, { type: "TEXT_MESSAGE_CONTENT", messageId: answer, delta: word });
      });
    }
    steps.push(() => {
      if (!live()) return;
      append(thread.id, runId, { type: "TEXT_MESSAGE_END", messageId: answer });
      append(thread.id, runId, {
        type: "RUN_FINISHED",
        threadId: thread.id,
        runId,
        outcome: { type: "success" },
      });
      setRun(thread.id, { active_run: null, last_run_state: "completed" });
    });
    play(steps);
    return { status: 202, body: run };
  }

  function decide(approval: Approval, allow: boolean): MockResponse {
    if (approval.state !== "pending") return err(409, "already_decided", `Already ${approval.state}.`);
    const decided: Approval = {
      ...approval,
      state: allow ? "allowed" : "denied",
      decided_by: "person",
      decided_at: now(),
    };
    approvals = approvals.filter((a) => a.id !== approval.id);
    append(approval.thread_id, approval.run_id, fixtures.approvalEvent(decided));
    if (!approvals.some((a) => a.thread_id === approval.thread_id)) {
      const thread = threads.find((t) => t.id === approval.thread_id);
      if (thread?.active_run) {
        const state = "running" as const;
        setRun(thread.id, { active_run: { ...thread.active_run, state }, last_run_state: state });
        const runId = thread.active_run.id;
        const id = nextId("m");
        const finish = () => {
          if (threads.find((t) => t.id === thread.id)?.active_run?.id !== runId) return;
          append(thread.id, runId, { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
          append(thread.id, runId, {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: id,
            delta: allow ? "Approved. Finished the work." : "Denied, so I stopped there.",
          });
          append(thread.id, runId, { type: "TEXT_MESSAGE_END", messageId: id });
          append(thread.id, runId, { type: "RUN_FINISHED", threadId: thread.id, runId, outcome: { type: "success" } });
          setRun(thread.id, { active_run: null, last_run_state: "completed" });
        };
        play([finish]);
      }
    }
    return { status: 200, body: decided };
  }

  /** Project rows follow the live list; everything else is the fixture state. */
  const workspaceBody = (): WorkspaceStatus => {
    const rows = fixtures.workspaceStatus(projects).targets;
    return {
      ...managed,
      targets: managed.configured ? rows : [],
    };
  };

  function setup(): MockResponse {
    if (failNextSetup) {
      failNextSetup = false;
      return err(502, "clone_failed", "The library remote couldn't be reached.");
    }
    managed = fixtures.workspaceStatus(projects);
    return { status: 200, body: workspaceBody() };
  }

  const activeRuns = () => threads.filter((t) => t.active_run).length;

  /** The server sends the reason; the client only shows it. */
  const updatesBody = (): UpdateStatus => {
    const runs = activeRuns();
    const dirty = managed.library?.dirty ?? false;
    const runsReason = runs > 0 ? (runs === 1 ? "1 run is active." : `${runs} runs are active.`) : null;
    const libraryReason = dirty ? "The library has local changes." : runsReason;
    return {
      ...updates,
      engines: updates.engines.map((engine) => ({ ...engine, blocked_reason: runsReason })),
      library: { ...updates.library, dirty, can_apply: libraryReason === null, blocked_reason: libraryReason },
      app: {
        ...updates.app,
        blocked_reason: updates.app.mode === "server" ? updates.app.blocked_reason : runsReason,
      },
    };
  };

  function finishStep(target: string) {
    if (target.startsWith("engine:")) {
      updates = {
        ...updates,
        engines: updates.engines.map((engine) =>
          `engine:${engine.id}` === target ? { ...engine, current: engine.latest } : engine,
        ),
      };
      const engine = engines.find((e) => `engine:${e.id}` === target);
      if (engine) engine.version = engine.latest;
    } else if (target === "library") {
      updates = {
        ...updates,
        library: { ...updates.library, current: updates.library.latest, behind: 0, incoming: [] },
      };
      if (managed.library) {
        managed = {
          ...managed,
          library: {
            ...managed.library,
            previous_revision: managed.library.revision,
            revision: updates.library.latest ?? managed.library.revision,
            behind: 0,
          },
        };
      }
    } else if (target === "app") {
      updates = { ...updates, app: { ...updates.app, current: updates.app.latest ?? updates.app.current } };
    }
  }

  function applyAll(): MockResponse {
    if (activeRuns() > 0) return err(409, "runs_active", "Runs are active.");
    const targets = [
      ...updates.engines
        .filter((e) => e.can_apply && e.latest !== e.current)
        .map((e) => `engine:${e.id}`),
      ...(updates.library.behind > 0 ? ["library"] : []),
      ...(updates.app.can_apply && updates.app.latest !== updates.app.current ? ["app"] : []),
    ];
    const result: ApplyAllResult = { steps: [] };
    for (const target of targets) {
      if (failStep === target) {
        failStep = null;
        result.steps.push({ target, ok: false, message: "The installer exited with status 1." });
        break;
      }
      finishStep(target);
      result.steps.push({ target, ok: true, message: null });
    }
    return { status: 200, body: result };
  }

  function newProject(path: string, trusted = false): Project {
    const project: Project = {
      id: nextId("p"),
      name: path.split("/").at(-1)?.replace(/\.git$/, "") ?? path,
      path,
      trusted,
      is_git: true,
      managed: false,
      scratch: false,
      created_at: now(),
    };
    projects = [...projects, project];
    return project;
  }

  function route(method: string, path: string, query: URLSearchParams, body: unknown): MockResponse {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
    const key = `${method} /${seg.slice(0, 2).join("/")}`;
    const data = (body ?? {}) as Record<string, unknown>;

    if (scenario === "remote" && !signedIn && !path.startsWith("/auth")) {
      return err(401, "unauthorized", "Sign in with the access key.");
    }

    switch (key) {
      case "GET /api/updates":
        return { status: 200, body: updatesBody() };
      case "POST /api/updates":
        if (seg[2] === "check") {
          updates = { ...updates, checked_at: new Date().toISOString() };
          return { status: 200, body: updatesBody() };
        }
        if (seg[2] === "apply-all") return applyAll();
        if (seg[2] === "app") {
          finishStep("app");
          return { status: 202 };
        }
        break;
      case "GET /api/settings":
        return { status: 200, body: settings };
      case "PUT /api/settings":
        settings = data as ServerSettings;
        return { status: 200, body: settings };
      case "GET /api/workspace":
        return { status: 200, body: workspaceBody() };
      case "POST /api/workspace":
        if (seg[2] === "setup") return setup();
        if (seg[2] === "update") {
          if (managed.library?.dirty) return err(409, "library_dirty", "The library has local changes.");
          if (activeRuns() > 0) return err(409, "runs_active", "Runs are active.");
          const list = updates.library.incoming;
          if (data.apply === true) finishStep("library");
          return {
            status: 200,
            body: {
              applied: data.apply === true,
              previous_revision: managed.library?.previous_revision ?? null,
              revision: managed.library?.revision ?? "",
              incoming: list,
            },
          };
        }
        if (seg[2] === "rollback" && managed.library?.previous_revision) {
          const revision = managed.library.previous_revision;
          managed = { ...managed, library: { ...managed.library, revision, previous_revision: null } };
          return { status: 200, body: { applied: true, previous_revision: null, revision, incoming: [] } };
        }
        break;
      case "DELETE /api/projects": {
        const row = workspaceBody().targets.find((t) => t.project_id === seg[2]);
        if (row?.dirty && query.get("confirm") !== "true") {
          return err(409, "project_has_work", "This checkout has uncommitted changes.");
        }
        projects = projects.filter((p) => p.id !== seg[2]);
        threads = threads.filter((t) => t.project_id !== seg[2]);
        return { status: 200, body: { files_removed: !row?.dirty, kept_path: row?.dirty ? row.path : null } };
      }
      case "GET /api/info":
        return { status: 200, body: { ...fixtures.info, remote: scenario === "remote" } };
      case "POST /auth/session":
        if (data.key === "orbyn-demo-key") {
          signedIn = true;
          return { status: 204 };
        }
        return err(401, "invalid_key", "That access key isn't valid.");
      case "GET /api/fs": {
        const at = query.get("path") ?? "/Users/dev";
        const node = fixtures.fsTree[at];
        if (!node) return { status: 200, body: { path: at, parent: fixtures.fsTree[at.split("/").slice(0, -1).join("/")] ? at.split("/").slice(0, -1).join("/") : "/Users/dev", entries: [] } };
        const join = (name: string) => (at === "/" ? `/${name}` : `${at}/${name}`);
        return {
          status: 200,
          body: {
            path: at,
            parent: node.parent,
            entries: node.entries.map((entry) => ({
              name: entry.name,
              path: join(entry.name),
              is_dir: true,
              is_git: entry.is_git ?? false,
            })),
          },
        };
      }
      case "GET /api/projects":
        return { status: 200, body: projects };
      case "POST /api/projects": {
        if (seg[2] === "clone") {
          const url = String(data.url ?? "");
          if (!/^(https?:\/\/|git@)/.test(url)) return err(400, "invalid_url", "Enter a Git URL.");
          return { status: 201, body: newProject(`/Users/dev/orbyn/${url.split("/").at(-1)}`) };
        }
        if (seg[2] === "create") {
          return { status: 201, body: newProject(`/Users/dev/orbyn/${String(data.name)}`, true) };
        }
        if (seg[2] === "add") {
          return { status: 201, body: newProject(String(data.path ?? "")) };
        }
        break;
      }
      case "DELETE /api/queue":
        queued = queued.filter((item) => item.id !== seg[2]);
        return { status: 204 };
      case "GET /api/editors":
        return { status: 200, body: [{ id: "code", name: "VS Code", launch_style: "goto", file_manager: false }] };
      case "GET /api/pulls":
        return { status: 200, body: { pulls: fixtures.pulls(), failed: [] } };
      case "GET /api/clones":
        return { status: 200, body: clones };
      case "POST /api/clones": {
        const project = newProject(String(data.url ?? "repo").split("/").at(-1)?.replace(".git", "") ?? "repo");
        const job = { id: `c-${clones.length}`, url: data.url, name: null, state: "done", project, error: null, used_https: false, started_at: now() };
        clones = [...clones, job];
        return { status: 202, body: job };
      }
      case "GET /api/usage":
        return {
          status: 200,
          body: { host_id: "mock", scanned_at: now(), engines: fixtures.usageEngines() },
        };
      case "GET /api/limits":
        return { status: 200, body: { pooled: [], engines: [], unavailable: [] } };
      case "PATCH /api/threads": {
        const thread = threads.find((t) => t.id === seg[2]);
        if (!thread) return err(404, "not_found", "Thread not found.");
        const stamp = now();
        const base = thread.lifecycle ?? fixtures.lifecycle();
        const patch = data as UpdateThread;
        const lifecycle = {
          ...base,
          ...(patch.pinned === undefined ? {} : { pinned_at: patch.pinned ? stamp : null }),
          ...(patch.settled === undefined ? {} : { settled_at: patch.settled ? stamp : null }),
          ...(patch.archived === undefined ? {} : { archived_at: patch.archived ? stamp : null }),
          ...(patch.unread === undefined ? {} : { unread: patch.unread }),
          ...(patch.permission_mode ? { permission_mode: patch.permission_mode } : {}),
        };
        threads = threads.map((t) =>
          t.id === thread.id ? { ...t, lifecycle, title: patch.title ?? t.title } : t,
        );
        return { status: 200, body: threads.find((t) => t.id === thread.id) };
      }
      case "GET /api/threads": {
        if (seg[2]) {
          if (seg[3] === "mentions") {
            const needle = (query.get("q") ?? "").toLowerCase();
            return {
              status: 200,
              body: {
                skills: ["architect", "tdd", "unslop"].filter((n) => n.includes(needle)),
                files: ["README.md", "src/main.rs", "src/lib.rs"].filter((f) => f.toLowerCase().includes(needle)),
                threads: [],
              },
            };
          }
          if (seg[3] === "queue") return { status: 200, body: queued.filter((q) => q.thread_id === seg[2]) };
          if (seg[3] === "commands") return { status: 200, body: fixtures.slashCommands };
          const thread = threads.find((t) => t.id === seg[2]);
          if (!thread) return err(404, "not_found", "Thread not found.");
          if (seg[3] === "diff") return { status: 200, body: fixtures.diffs[thread.id] ?? [] };
          return { status: 200, body: thread };
        }
        const id = query.get("project_id");
        return {
          status: 200,
          body: threads
            .filter((t) => !id || t.project_id === id)
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        };
      }
      case "DELETE /api/threads":
        threads = threads.filter((t) => t.id !== seg[2]);
        return { status: 204 };
      case "GET /api/approvals":
        return { status: 200, body: approvals };
      case "GET /api/engines":
        if (seg[3] === "models") return { status: 200, body: fixtures.engineModels(seg[2] ?? "") };
        return { status: 200, body: engines };
      default:
        break;
    }

    if (method === "POST" && seg[0] === "api") {
      if (seg[1] === "projects" && seg[3] === "trust") {
        const project = projects.find((p) => p.id === seg[2]);
        if (!project) return err(404, "not_found", "Project not found.");
        project.trusted = true;
        return { status: 200, body: project };
      }
      if (seg[1] === "threads" && !seg[2]) {
        const engine = engines.find((e) => e.id === data.engine);
        const project = projects.find((p) => p.id === data.project_id);
        if (!engine || !project) return err(400, "invalid_request", "Unknown engine or project.");
        const purpose = typeof data.worktree === "string" && data.worktree ? data.worktree : null;
        const thread: Thread = {
          scratch: false,
          id: nextId("t"),
          project_id: project.id,
          title: typeof data.title === "string" && data.title ? data.title : "New thread",
          engine: engine.id,
          model: typeof data.model === "string" ? data.model : null,
          cwd: purpose ? `${project.path}-wt/${purpose}` : project.path,
          worktree: purpose
            ? { path: `${project.path}-wt/${purpose}`, branch: purpose, base: "main" }
            : null,
          skill_profile: typeof data.skill_profile === "string" ? data.skill_profile : null,
          active_run: null,
          last_run_state: null,
          created_at: new Date(fixtures.T0 + 3600_000).toISOString(),
          updated_at: new Date(fixtures.T0 + 3600_000).toISOString(),
        };
        threads = [...threads, thread];
        return { status: 201, body: thread };
      }
      if (seg[1] === "threads" && seg[3] === "queue" && !seg[4]) {
        const item: QueuedMessage = {
          id: nextId("q"),
          thread_id: seg[2] ?? "",
          prompt: String(data.prompt),
          attachment_ids: [],
          held: false,
          created_at: now(),
        };
        queued = [...queued, item];
        return { status: 201, body: item };
      }
      if (seg[1] === "threads" && seg[3] === "steer") return { status: 202 };
      if (seg[1] === "queue" && seg[3] === "send-now") {
        queued = queued.filter((item) => item.id !== seg[2]);
        return { status: 202 };
      }
      if (seg[1] === "threads" && seg[3] === "attachments") {
        return { status: 201, body: { id: nextId("att"), thread_id: seg[2], name: query.get("name") ?? "file", mime: "", size: 1, created_at: now() } };
      }
      if (seg[1] === "threads" && seg[3] === "runs") {
        const thread = threads.find((t) => t.id === seg[2]);
        if (!thread) return err(404, "not_found", "Thread not found.");
        return startRun(thread, String(data.prompt ?? ""));
      }
      if (seg[1] === "runs" && seg[3] === "cancel") {
        const thread = threads.find((t) => t.active_run?.id === seg[2]);
        if (!thread) return err(404, "not_found", "No active run.");
        const runId = seg[2] ?? "";
        for (const approval of approvals.filter((a) => a.run_id === runId)) {
          append(thread.id, runId, fixtures.approvalEvent({ ...approval, state: "expired" }));
        }
        approvals = approvals.filter((a) => a.run_id !== runId);
        append(thread.id, runId, {
          type: "RUN_FINISHED",
          threadId: thread.id,
          runId,
          outcome: { type: "cancelled" },
        });
        setRun(thread.id, { active_run: null, last_run_state: "cancelled" });
        return { status: 204 };
      }
      if (seg[1] === "approvals" && seg[3] === "decide") {
        const approval = approvals.find((a) => a.id === seg[2]);
        if (!approval) return err(409, "already_decided", "This approval was already decided.");
        return decide(approval, data.allow === true);
      }
      if (seg[1] === "engines" && seg[2] === "refresh") return { status: 200, body: engines };
      if (seg[1] === "engines" && seg[2] === "custom") {
        const tier = data.tier as EngineStatus["tier"];
        const engine: EngineStatus = {
          id: String(data.id),
          name: String(data.name),
          tier,
          capabilities: {
            streaming: tier !== "terminal",
            goal_control: false,
            approvals: tier !== "terminal",
            resume: false,
            mcp: false,
            sandbox: false,
            managed: tier !== "terminal",
            skill_delivery: [],
          },
          installed: true,
          path: String(data.target),
          version: null,
          auth: "not_applicable",
          installer: "unknown",
          latest: null,
          support: "unknown",
          update_command: null,
          manual_hint: "Custom engines are updated by you.",
          sign_in_command: null,
          updating: false,
          problem: null,
        };
        engines = [...engines, engine];
        return { status: 201, body: engine };
      }
      if (seg[1] === "engines" && seg[3] === "update") {
        const engine = engines.find((e) => e.id === seg[2]);
        if (!engine) return err(404, "not_found", "Engine not found.");
        if (threads.some((t) => t.engine === engine.id && t.active_run)) {
          return err(409, "engine_busy", `${engine.name} has an active run. Finish or cancel it first.`);
        }
        engine.updating = true;
        const timer = setTimeout(() => {
          engine.updating = false;
          finishStep(`engine:${engine.id}`);
          engine.version = engine.latest;
        }, stepMs * 20);
        timers.add(timer);
        return { status: 202 };
      }
    }

    if (method === "DELETE" && seg[0] === "api") {
      if (seg[1] === "engines" && seg[2] === "custom") {
        engines = engines.filter((e) => e.id !== seg[3]);
        return { status: 204 };
      }
    }
    return err(404, "not_found", `No mock for ${method} ${path}.`);
  }

  return {
    reset,
    get scenario() {
      return scenario;
    },
    get delayMs() {
      return delayMs;
    },
    set delayMs(value: number) {
      delayMs = value;
    },
    get threads() {
      return threads;
    },
    /** Queues a failure for the next `times` requests under `path`. */
    fail(path: string, times: number, status = 500, code = "internal", message = "Something went wrong.") {
      failures.push({ path, remaining: times, status, code, message });
    },
    handle(method: string, url: string, body?: unknown): MockResponse {
      const parsed = new URL(url, "http://mock.local");
      if (scenario === "offline" && parsed.pathname.startsWith("/api")) {
        return err(503, "unavailable", "The service is unavailable.");
      }
      const failure = failures.find((f) => parsed.pathname.startsWith(f.path) && f.remaining > 0);
      if (failure) {
        failure.remaining -= 1;
        return err(failure.status, failure.code, failure.message);
      }
      return route(method, parsed.pathname, parsed.searchParams, body);
    },
    events(threadId: string, after: number): WireThreadEvent[] {
      return (logs[threadId] ?? []).filter((event) => event.seq > after);
    },
    subscribe(threadId: string, subscriber: Subscriber): () => void {
      const set = subscribers.get(threadId) ?? new Set<Subscriber>();
      subscribers.set(threadId, set);
      set.add(subscriber);
      return () => set.delete(subscriber);
    },
    /** Makes the next setup attempt end in the failed state. */
    failSetup() {
      failNextSetup = true;
    },
    /** Fails the given step of the next apply, once. */
    failUpdateStep(id: string) {
      failStep = id;
    },
    patchUpdates(patch: Partial<UpdateStatus>) {
      updates = { ...updates, ...patch };
    },
    patchWorkspace(patch: Partial<WorkspaceStatus>) {
      managed = { ...managed, ...patch };
    },
    get workspace() {
      return managed;
    },
    get updates() {
      return updates;
    },
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
