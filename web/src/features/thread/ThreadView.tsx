import {
  ArrowLeft,
  Brain,
  CircleCheck,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Rows3,
  ShieldAlert,
  Target,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { useCommand } from "../../app/shortcuts";
import type { Project, RunState, Thread } from "../../api/types";
import { relativeTime, runStateLabels } from "../../lib/format";
import { useLingering, usePanelMotion } from "../../lib/panelAnimations";
import { isWide, useLayoutWidth } from "../../lib/useLayout";
import { routeHref } from "../../state/route";
import { useThreadLogs, useThreadStream } from "../../state/threadLogs";
import { GitActions } from "./GitControl";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { ProjectBadge } from "../../ui/badges";
import { Button, IconButton, LinkButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SurfacePane } from "../panels/SurfacePane";
import { TerminalDrawerBody } from "../panels/TerminalDrawerBody";
import { threadRunState } from "../workspace/RunState";
import { RelatedThreads } from "./RelatedThreads";
import { Composer } from "./Composer";
import { DetailsCard } from "./DetailsCard";
import { composerSettled, useComposerDock } from "./heroTransition";
import { runningTools } from "./timeline";
import { implementPrompt, planTitle, proposedPlanIn } from "./proposedPlan";
import { SubagentBar } from "./SubagentBar";
import { LimitBanner, ThreadErrorBanner } from "./ThreadBanners";
import { ThreadFind } from "./ThreadFind";
import { Transcript } from "./Transcript";
import { ProjectActionShortcuts } from "./ProjectActionShortcuts";

function TopBar({
  thread,
  project,
  detailsShown,
  paneShown,
  onToggleDetails,
  onTogglePane,
}: {
  thread: Thread;
  project: Project | null;
  detailsShown: boolean;
  paneShown: boolean;
  onToggleDetails(): void;
  onTogglePane(): void;
}) {
  const layout = useLayoutWidth();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const togglePanel = useUi((state) => state.togglePanel);
  const narrow = layout === "narrow";

  return (
    <header className="topbar">
      {narrow ? (
        <a className="icon-btn" href={routeHref({ name: "home" })} aria-label="Back to threads" title="Back to threads">
          <ArrowLeft size={16} aria-hidden />
        </a>
      ) : collapsed ? (
        <IconButton label="Expand sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden />
        </IconButton>
      ) : null}
      <div className="crumbs">
        {project ? (
          <>
            <ProjectBadge name={project.name} />
            <span className="crumb-project" title={project.path}>
              {project.name}
            </span>
            <span className="crumb-slash" aria-hidden>
              /
            </span>
          </>
        ) : null}
        <h1 tabIndex={-1} data-page-title title={thread.title}>
          {thread.title}
        </h1>
      </div>
      <RelatedThreads thread={thread} />
      <GitActions thread={thread} />
      <div className="layout-toggles" role="group" aria-label="Layout">
        <IconButton label="Details" pressed={detailsShown} onClick={onToggleDetails}>
          <Rows3 size={16} aria-hidden />
        </IconButton>
        {narrow || paneShown ? null : (
          <>
            <IconButton label="Terminal" pressed={terminalOpen} onClick={() => togglePanel("terminal")}>
              <PanelBottom size={16} aria-hidden />
            </IconButton>
            <IconButton label="Surfaces" onClick={onTogglePane}>
              <PanelRight size={16} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

const statusSentence = (state: RunState, tools: number): string => {
  if (state === "running") {
    if (tools === 0) return "Thinking";
    return tools === 1 ? "Waiting on 1 tool" : `Waiting on ${tools} tools`;
  }
  return runStateLabels[state];
};

/** The server's run state, with the Stop action, at the end of the conversation. */
/** The goal at the end of the thread, and the words that change it. */
function GoalLine({ thread, canPause }: { thread: Thread; canPause: boolean }) {
  const goal = thread.goal;
  const refreshThread = useWorkspace((store) => store.refreshThread);
  const pushToast = useUi((store) => store.pushToast);
  if (!goal) return null;
  const send = (prompt: string) => {
    (thread.active_run ? api.enqueue(thread.id, prompt, []) : api.startRun(thread.id, prompt)).then(
      () => void refreshThread(thread.id),
      (failure: unknown) => pushToast(`Couldn't change the goal. ${toFailure(failure).message}`),
    );
  };
  const paused = goal.status === "paused";
  return (
    <p className="end-line">
      <Target size={14} aria-hidden />
      <span className="end-line-text">
        Goal: {goal.objective}
        {goal.status === "active" ? "" : ` (${goal.status.replace(/_/g, " ")})`}
      </span>
      {canPause ? (
        <button type="button" className="text-action" onClick={() => send(paused ? "/goal resume" : "/goal pause")}>
          {paused ? "Resume" : "Pause"}
        </button>
      ) : null}
      <button type="button" className="text-action" onClick={() => send("/goal clear")}>
        Clear
      </button>
    </p>
  );
}

function RunStatusLine({ thread }: { thread: Thread }) {
  const state = threadRunState(thread);
  const active = thread.active_run;
  const log = useThreadLogs((store) => store.logs[thread.id]);
  const tools = useMemo(() => (active ? runningTools(log?.items ?? []) : []), [log, active]);
  const putThread = useWorkspace((store) => store.putThread);

  if (!state) return <div className="thread-state" role="status" />;
  if (!active) {
    // Failed and cancelled runs already have a notice in the log.
    const settledAt = thread.lifecycle?.settled_at;
    return (
      <div className="thread-state" role="status">
        <span className={state === "interrupted" ? "run-status" : "sr-only"}>{runStateLabels[state]}</span>
        {settledAt ? (
          <p className="end-line">
            <CircleCheck size={14} aria-hidden />
            Settled {relativeTime(settledAt).toLowerCase()}
            <button
              type="button"
              className="text-action"
              onClick={() => {
                void api.patchThread(thread.id, { settled: false }).then(putThread);
              }}
            >
              Unsettle
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  // The approval row itself says what the run is waiting for.
  if (state === "awaiting_approval") {
    return (
      <div className="thread-state" role="status">
        <span className="sr-only">Approval</span>
      </div>
    );
  }

  return (
    <div className="thread-state run-status-row" role="status">
      {tools.length === 0 ? <Brain size={14} aria-hidden /> : <span className="status-dot tone-info" aria-hidden />}
      <span className="run-status text-sweep">{statusSentence(state, tools.length)}</span>
      {tools.length > 0 ? (
        <span className="run-status-detail">{tools.map((tool) => tool.name).join(", ")}</span>
      ) : null}
    </div>
  );
}

/** Once a turn has proposed a plan, offers to act on it. */
function PlanBanner({ thread }: { thread: Thread }) {
  const log = useThreadLogs((store) => store.logs[thread.id]);
  const addPrompt = useThreadLogs((store) => store.addPrompt);
  const putThread = useWorkspace((store) => store.putThread);
  const last = log?.items.at(-1);
  const plan = last?.kind === "message" && last.role !== "user" && last.done ? proposedPlanIn(last.text) : null;
  if (!plan || thread.active_run) return null;
  const implement = async () => {
    if (thread.lifecycle?.plan_mode) putThread(await api.patchThread(thread.id, { plan_mode: false }));
    const prompt = implementPrompt(plan);
    const run = await api.startRun(thread.id, prompt);
    addPrompt(thread.id, { runId: run.id, text: prompt });
  };
  return (
    <div className="plan-banner" role="status">
      <strong>Plan ready</strong>
      <span>{planTitle(plan)}</span>
      <Button small onClick={() => void implement()}>
        Implement plan
      </Button>
    </div>
  );
}

const PROACTIVE_FILES = 3;
const PROACTIVE_LINES = 50;

/** Runs that already had their chance, so closing the panel or coming back never reopens it. */
const proactiveHandled = new Set<string>();

/** Opens Changes after a turn that touched a lot, unless the setting is off or a panel is up. */
function useProactivePanels(threadId: string, runId: string | null) {
  const live = useRef(new Set<string>());
  const changed = useThreadLogs((state) => state.logs[threadId]?.items.findLast((item) => item.kind === "diff"));
  useEffect(() => {
    if (runId) live.current.add(runId);
  }, [runId]);
  useEffect(() => {
    if (runId || changed?.kind !== "diff" || !changed.runId || proactiveHandled.has(changed.runId)) return;
    // A fast turn can end before this view sees it run, so one sent from here counts too.
    const sentHere = useThreadLogs.getState().prompts[threadId]?.some((prompt) => prompt.runId === changed.runId);
    if (!sentHere && !live.current.has(changed.runId)) return;
    proactiveHandled.add(changed.runId);
    const ui = useUi.getState();
    if (!ui.proactivePanels || ui.panelOpen === true) return;
    const lines = changed.files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
    if (changed.files.length >= PROACTIVE_FILES || lines >= PROACTIVE_LINES) ui.togglePanel("diff");
  }, [threadId, runId, changed]);
}

function StreamBanner({ threadId }: { threadId: string }) {
  const status = useThreadLogs((state) => state.streams[threadId]?.status);
  if (status !== "reconnecting") return null;
  return (
    <p className="end-line" role="status">
      <WifiOff size={14} aria-hidden />
      <span className="end-line-text">Reconnecting. The thread resumes from the last event.</span>
    </p>
  );
}

/** Keeps its socket and scrollback once opened; a phone shows it instead of the thread. */
function TerminalDrawer({ threadId, open, onClose }: { threadId: string; open: boolean; onClose(): void }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <section className="drawer" hidden={!open} aria-label="Terminal">
      <TerminalDrawerBody threadId={threadId} onClose={onClose} />
    </section>
  );
}

function DraftHero({ project }: { project: Project | null }) {
  return (
    <div className="hero">
      <h2 className="hero-title">
        What should we build in <strong>{project?.name ?? "this project"}</strong>?
      </h2>
    </div>
  );
}

const VISIT_MARK_MS = 500;

/** What you had read when you came here, kept while you stay. The service hears both ends. */
function useVisit(id: string, visitedAt: string | null, updatedAt: string | undefined) {
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  if (updatedAt !== undefined && seen === undefined) setSeen(visitedAt);
  const shown = useRef(false);
  shown.current = updatedAt !== undefined;
  useEffect(() => {
    const mark = () => {
      api.patchThread(id, { visited: true }).then(useWorkspace.getState().putThread, () => undefined);
    };
    // What arrives while you are here counts as read, even if the window just closes.
    const timer = shown.current ? setTimeout(mark, VISIT_MARK_MS) : undefined;
    return () => clearTimeout(timer);
  }, [id, updatedAt]);
  useEffect(
    () => () => {
      if (!shown.current) return;
      api.patchThread(id, { visited: true }).then(useWorkspace.getState().putThread, () => undefined);
    },
    [id],
  );
  return seen ?? null;
}

export function ThreadView({ id }: { id: string }) {
  const thread = useWorkspace((state) => state.threads[id]);
  const missing = useWorkspace((state) => state.missingThreads[id]);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const engines = useWorkspace((state) => state.engines.data);
  const projects = useWorkspace((state) => state.projects.data);
  const setLastThread = useUi((state) => state.setLastThread);
  const panelPref = useUi((state) => state.panelOpen);
  const closePanel = useUi((state) => state.closePanel);
  const setPanelOpen = useUi((state) => state.setPanelOpen);
  const detailsPref = useUi((state) => state.detailsOpen);
  const toggleDetailsPref = useUi((state) => state.toggleDetails);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const togglePanel = useUi((state) => state.togglePanel);
  const chatWidth = useUi((state) => state.chatWidth);
  const layout = useLayoutWidth();
  const wide = isWide(layout);
  const [detailsOverlay, setDetailsOverlay] = useState(false);
  const [finding, setFinding] = useState(false);
  useCommand("chat.find", () => setFinding(true));
  const maximized = useUi((state) => state.panelMaximized);
  const setMaximized = useUi((state) => state.setPanelMaximized);
  const [docked, setDocked] = useState(false);
  const stream = useThreadLogs((state) => state.streams[id]?.status);
  const hasContent = useThreadLogs(
    (state) => (state.logs[id]?.items.length ?? 0) > 0 || (state.prompts[id]?.length ?? 0) > 0,
  );
  const motion = usePanelMotion();
  useThreadStream(id);
  useProactivePanels(id, thread?.active_run?.id ?? null);
  const lastVisit = useVisit(id, thread?.lifecycle?.visited_at ?? null, thread?.updated_at);

  useEffect(() => {
    setLastThread(id);
    void refreshThread(id);
  }, [id, refreshThread, setLastThread]);

  const project = useMemo(
    () => projects?.find((p) => p.id === thread?.project_id) ?? null,
    [projects, thread?.project_id],
  );

  const hero =
    !docked &&
    !hasContent &&
    stream === "live" &&
    thread !== undefined &&
    thread.active_run === null &&
    thread.last_run_state === null;
  const { mover, anchor, recordStart } = useComposerDock(hero, motion.enabled, motion.durationMs);

  const panelOpen = panelPref ?? layout === "xwide";
  const panelPresent = useLingering(panelOpen, motion.enabled ? motion.durationMs : 0);

  if (!thread) {
    if (missing) {
      return missing.status === 404 ? (
        <div className="page">
          <Empty title="Thread not found">
            <LinkButton href={routeHref({ name: "home" })}>Back to workspace</LinkButton>
          </Empty>
        </div>
      ) : (
        <div className="page">
          <ErrorState title="Couldn't load this thread" failure={missing} onRetry={() => void refreshThread(id)} />
        </div>
      );
    }
    return (
      <div className="page">
        <Loading label="Loading thread" />
      </div>
    );
  }

  const engine = engineById(engines, thread.engine);
  const swapped = panelOpen && (!wide || maximized);
  const terminalTakesOver = terminalOpen && layout === "narrow";
  const detailsFit = layout === "xwide" || !panelOpen;
  const detailsShown = wide ? detailsPref && detailsFit : detailsOverlay;

  const beforeSend = async () => {
    if (!hero) return;
    recordStart();
    flushSync(() => setDocked(true));
    await composerSettled();
  };

  return (
    <div className="thread-layout">
      <ProjectActionShortcuts threadId={id} />
      <section
        className="thread-main"
        hidden={swapped}
        aria-label={thread.title}
        data-details={wide && detailsShown ? "reserved" : undefined}
        data-chat-width={chatWidth}
      >
        <TopBar
          thread={thread}
          project={project}
          detailsShown={detailsShown}
          paneShown={panelOpen && wide}
          onToggleDetails={() => (wide ? toggleDetailsPref() : setDetailsOverlay(!detailsOverlay))}
          onTogglePane={() => setPanelOpen(true)}
        />
        {finding ? <ThreadFind onClose={() => setFinding(false)} /> : null}
        <div className="thread-stage" hidden={terminalTakesOver} data-hero={hero || undefined}>
          {project && !project.trusted ? (
            <p className="banner banner-warn">
              <ShieldAlert size={16} aria-hidden />
              <span>This folder isn't trusted yet, so engines can't run here.</span>
              <a href={routeHref({ name: "trust", projectId: project.id, threadId: id })}>Review folder</a>
            </p>
          ) : null}
          {hero ? null : (
            <Transcript
              activeRunId={thread.active_run?.id ?? null}
              threadId={id}
              active={thread.active_run !== null}
              readUpTo={lastVisit}
                footer={
                  <>
                    <StreamBanner threadId={id} />
                    <GoalLine thread={thread} canPause={engine?.capabilities.goal_control === true} />
                    <RunStatusLine thread={thread} />
                  </>
                }
            />
          )}
          <ThreadErrorBanner thread={thread} />
          <LimitBanner thread={thread} />
          <div className="composer-lane">
            <div ref={mover} className="composer-group">
              <div className="composer-stack">
                {hero ? <DraftHero project={project} /> : null}
                <PlanBanner thread={thread} />
                <div ref={anchor}>
                  {thread.lifecycle?.relation === "subagent" ? (
                    <SubagentBar thread={thread} />
                  ) : (
                    <Composer
                      thread={thread}
                      engine={engine}
                      beforeSend={beforeSend}
                      onSendFailed={() => setDocked(false)}
                      showContext={hero}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <TerminalDrawer threadId={id} open={terminalOpen} onClose={() => togglePanel("terminal")} />
        {detailsShown ? (
          <DetailsCard
            thread={thread}
            engine={engine}
            compact={!wide}
            onClose={() => setDetailsOverlay(false)}
          />
        ) : null}
      </section>
      {panelPresent ? (
        <SurfacePane
          thread={thread}
          overlay={!wide}
          closing={!panelOpen}
          maximized={maximized}
          onToggleMaximize={() => setMaximized(!maximized)}
          onReturn={() => {
            setMaximized(false);
            closePanel();
          }}
        />
      ) : null}
    </div>
  );
}
