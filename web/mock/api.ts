/**
 * createMockApi: an in-memory service with the architecture's HTTP contract.
 * The dev-server plugin and the tests both drive it through `handle`.
 */
import type {
  AgUiEvent,
  Approval,
  EngineStatus,
  Project,
  Thread,
  WireThreadEvent,
} from "../src/api/types.ts";
import type { WorkspaceStatus } from "../src/api/workspace.ts";
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
  let skills = structuredClone(fixtures.skills);
  let profiles = structuredClone(fixtures.profiles);
  let rules = structuredClone(fixtures.rules);
  let managed: WorkspaceStatus = fixtures.workspaceStatus([]);
  let failNextSetup = false;
  let failures: Failure[] = [];
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
    if (next === "first-run") {
      managed = { ...managed, state: "unset", library: null, projects: [] };
    }
    engines = structuredClone(fixtures.engines);
    skills = structuredClone(fixtures.skills);
    profiles = structuredClone(fixtures.profiles);
    rules = structuredClone(fixtures.rules);
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

  function decide(approval: Approval, allow: boolean, remember: boolean): MockResponse {
    if (approval.state !== "pending") return err(409, "already_decided", `Already ${approval.state}.`);
    const decided: Approval = {
      ...approval,
      state: allow ? "allowed" : "denied",
      decided_by: "person",
      decided_at: now(),
    };
    approvals = approvals.filter((a) => a.id !== approval.id);
    append(approval.thread_id, approval.run_id, fixtures.approvalEvent(decided));
    if (remember) {
      rules = [
        ...rules,
        {
          id: nextId("rule"),
          effect: "allow",
          kind: approval.kind,
          pattern: approval.summary,
          engine: null,
          note: "Added from an approval.",
          created_at: now(),
        },
      ];
    }
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
  const workspaceBody = () => {
    const rows = fixtures.workspaceStatus(projects).projects;
    return {
      ...managed,
      projects: rows.map((row) => managed.projects.find((p) => p.id === row.id) ?? row),
      active_runs: threads.filter((t) => t.active_run).length,
    };
  };

  function setup(data: Record<string, unknown>): MockResponse {
    if (data.mode === "adopt" && typeof data.path !== "string") {
      return err(400, "invalid_path", "Choose a folder.");
    }
    const failing = failNextSetup;
    failNextSetup = false;
    managed = { ...managed, state: "setting_up", step: "Cloning the skill library", error: null };
    const timer = setTimeout(() => {
      const ready = fixtures.workspaceStatus(projects);
      managed = failing
        ? { ...managed, state: "failed", step: null, error: "The library remote couldn't be reached." }
        : { ...ready };
    }, stepMs * 5);
    timers.add(timer);
    return { status: 202, body: workspaceBody() };
  }

  function newProject(path: string, trusted = false): Project {
    const project: Project = {
      id: nextId("p"),
      name: path.split("/").at(-1)?.replace(/\.git$/, "") ?? path,
      path,
      trusted,
      is_git: true,
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
      case "GET /api/workspace":
        return { status: 200, body: workspaceBody() };
      case "POST /api/workspace":
        if (seg[2] === "setup") return setup(data);
        if (seg[2] === "update") {
          if (managed.library?.modified) return err(409, "library_modified", "The library has local changes.");
          if (managed.library) {
            managed = {
              ...managed,
              library: {
                ...managed.library,
                previous_revision: managed.library.revision,
                revision: managed.library.incoming[0]?.revision ?? managed.library.revision,
                behind: 0,
                incoming: [],
              },
            };
          }
          return { status: 200, body: workspaceBody() };
        }
        if (seg[2] === "rollback" && managed.library?.previous_revision) {
          managed = {
            ...managed,
            library: { ...managed.library, revision: managed.library.previous_revision, previous_revision: null },
          };
          return { status: 200, body: workspaceBody() };
        }
        break;
      case "DELETE /api/projects": {
        const row = workspaceBody().projects.find((p) => p.id === seg[2]);
        if (row && (row.modified || row.unpushed) && query.get("force") !== "true") {
          return err(409, "project_at_risk", "This checkout has work that exists nowhere else.");
        }
        projects = projects.filter((p) => p.id !== seg[2]);
        threads = threads.filter((t) => t.project_id !== seg[2]);
        return { status: 204 };
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
        if (seg[2] === "import") {
          const source = String(data.path ?? "");
          if (data.dry_run === true) return { status: 200, body: fixtures.importPreview(source) };
          return { status: 201, body: { project: newProject(source) } };
        }
        break;
      }
      case "GET /api/threads": {
        if (seg[2]) {
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
        return { status: 200, body: engines };
      case "GET /api/skills":
        if (seg[2] === "profiles") return { status: 200, body: profiles };
        return { status: 200, body: skills };
      case "GET /api/policy":
        return { status: 200, body: rules };
      case "GET /api/audit": {
        const id = query.get("thread_id");
        const limit = Number(query.get("limit") ?? 100);
        return {
          status: 200,
          body: fixtures.audit().filter((row) => !id || row.thread_id === id).slice(0, limit),
        };
      }
      case "GET /api/computer":
        return { status: 200, body: fixtures.computer };
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
        return decide(approval, data.allow === true, data.remember === true);
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
          engine.version = engine.latest;
        }, stepMs * 20);
        timers.add(timer);
        return { status: 202 };
      }
      if (seg[1] === "skills" && seg[2] === "rebuild") return { status: 200, body: skills };
      if (seg[1] === "skills" && seg[2] === "profiles") {
        const profile = { id: nextId("sp"), name: String(data.name), skills: (data.skills ?? []) as string[] };
        profiles = [...profiles, profile];
        return { status: 201, body: profile };
      }
      if (seg[1] === "policy" && seg[2] === "rules") {
        const rule = { ...(data as object), id: nextId("rule"), created_at: now() } as (typeof rules)[number];
        rules = [...rules, rule];
        return { status: 201, body: rule };
      }
    }

    if (method === "DELETE" && seg[0] === "api") {
      if (seg[1] === "engines" && seg[2] === "custom") {
        engines = engines.filter((e) => e.id !== seg[3]);
        return { status: 204 };
      }
      if (seg[1] === "skills" && seg[2] === "profiles") {
        profiles = profiles.filter((p) => p.id !== seg[3]);
        return { status: 204 };
      }
      if (seg[1] === "policy" && seg[2] === "rules") {
        rules = rules.filter((r) => r.id !== seg[3]);
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
    patchWorkspace(patch: Partial<WorkspaceStatus>) {
      managed = { ...managed, ...patch };
    },
    get workspace() {
      return managed;
    },
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
