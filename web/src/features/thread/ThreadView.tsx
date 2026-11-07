import {
  Brain,
  GitBranch,
  CircleCheck,
  Loader2,
  PanelRight,
  SquareTerminal,
  Info,
  ShieldAlert,
  Target,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { runHandlers, useCommand } from "../../app/shortcuts";
import type { EngineStatus, Project, RunState, Thread } from "../../api/types";
import { relativeTime, runStateLabels } from "../../lib/format";
import { useLingering, usePanelMotion, useSettledAfter } from "../../lib/panelAnimations";
import { isWide, panelOverlays, useLayoutWidth } from "../../lib/useLayout";
import { useEscapeClose } from "../../ui/useEscapeClose";
import { usePopover } from "../../ui/usePopover";
import { useSidebarDrawer } from "../../app/sidebarDrawer";
import { markReachable, markUnreachable, useConnectionKind } from "../../state/connection";
import { routeHref } from "../../state/route";
import { useThreadLogs, useThreadStream } from "./threadLogs";
import { BranchShortcut, GitActions } from "./GitControl";
import { LedgerPin } from "./LedgerPin";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { Button, IconButton, LinkButton } from "../../ui/controls";
import { Empty, ErrorState, Loading, NarrowBack } from "../../ui/states";
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
import { ConnectionStatus, ServiceDownBanner } from "./ConnectionStatus";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { ThreadFind } from "./ThreadFind";
import { Transcript } from "./Transcript";
import { FavoriteEditorShortcut } from "./OpenInEditor";
import { ProjectActionShortcuts } from "./ProjectActionShortcuts";

/** The details card under the Details button while the side panel is closed. Escape or a press outside dismisses it. */
function DetailsPopover({ thread, engine, compact, onClose }: { thread: Thread; engine: EngineStatus | null; compact: boolean; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  usePopover({ kind: "fields", root, trigger: () => document.querySelector<HTMLElement>("[data-details-toggle]"), onClose });
  return (
    <div ref={root} className="details-popover">
      <DetailsCard thread={thread} engine={engine} compact={compact} onClose={onClose} />
    </div>
  );
}

function TopBar({
  thread,
  project,
  detailsShown,
  detailsPopup,
  paneShown,
  onToggleDetails,
  onTogglePane,
}: {
  thread: Thread;
  project: Project | null;
  detailsShown: boolean;
  /** The card opens as a popover under the button. */
  detailsPopup: boolean;
  paneShown: boolean;
  onToggleDetails(): void;
  onTogglePane(): void;
}) {
  const layout = useLayoutWidth();
  const terminalOpen = useUi((state) => state.terminalOpen);
  const togglePanel = useUi((state) => state.togglePanel);
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const state = threadRunState(thread);
  const narrow = layout === "phone";
  const connection = useConnectionKind();

  return (
    <header className="topbar">
      {narrow ? <NarrowBack /> : null}
      <div className="crumbs">
        <h1 tabIndex={-1} data-page-title title={thread.title}>
          {thread.title}
        </h1>
        <span className="page-sub">
          {branch ? (
            <span className="page-sub-item">
              <GitBranch size={13} aria-hidden />
              {branch}
            </span>
          ) : null}
          {project ? (
            <span className="page-sub-item" title={project.path}>
              {project.name}
            </span>
          ) : null}
          {connection ? <ConnectionStatus /> : thread.active_run && state ? <span className="page-sub-item">{runStateLabels[state]}</span> : null}
        </span>
      </div>
      <RelatedThreads thread={thread} />
      <GitActions thread={thread} />
      {branch ? <BranchShortcut thread={thread} /> : null}
      <div className="layout-toggles" role="group" aria-label="Layout">
        <Button small tone="quiet" className="topbar-details" data-details-toggle aria-pressed={detailsShown} aria-haspopup={detailsPopup ? "dialog" : undefined} icon={<Info size={16} aria-hidden />} onClick={onToggleDetails}>
          Details
        </Button>
        <IconButton label="Terminal" pressed={terminalOpen} onClick={() => togglePanel("terminal")}>
          <SquareTerminal size={16} aria-hidden />
        </IconButton>
        {narrow ? null : (
          <IconButton label="Show side panel" data-panel-toggle pressed={paneShown} onClick={onTogglePane}>
            <PanelRight size={16} aria-hidden />
          </IconButton>
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
      {tools.length === 0 ? <Brain size={14} aria-hidden /> : <Loader2 size={14} className="spin" aria-hidden />}
      <span className="run-status">{statusSentence(state, tools.length)}</span>
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
      <Button
        small
        tone="quiet"
        onClick={() => runHandlers("composer.focus")}
      >
        Suggest changes
      </Button>
      <Button small onClick={() => void implement()}>
        Approve and start
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

/** Keeps its socket and scrollback once opened; a phone shows it instead of the thread. */
function TerminalDrawer({
  threadId,
  open,
  moves,
  onClose,
}: {
  threadId: string;
  open: boolean;
  moves: boolean;
  onClose(): void;
}) {
  const [opened, setOpened] = useState(open);
  const { exitMs } = usePanelMotion();
  // Stays shown while it slides out, then hides.
  const shown = useLingering(open, exitMs);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <section className="drawer" hidden={!shown} data-closing={!open || undefined} data-moves={moves || undefined} aria-label="Terminal">
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
  const phone = layout === "phone";
  const overlays = panelOverlays(layout);
  const ledger = useUi((state) => state.workspaceLayout === "ledger");
  const [detailsPopover, setDetailsPopover] = useState(false);
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
  // The thread's own stream is the app's live signal for the service: it only fails to connect when
  // the service, or the network under it, does not answer.
  useEffect(() => {
    if (stream === "live") markReachable();
    else if (stream === "reconnecting") markUnreachable();
  }, [stream]);
  const connection = useConnectionKind();
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
  // Over the thread, Escape closes the panel and focus goes back to the header button.
  useEscapeClose(panelOpen && overlays && !maximized, () => setPanelOpen(false), () =>
    document.querySelector<HTMLElement>("[data-panel-toggle]"),
  );
  // The card moves into the panel when it opens.
  useEffect(() => {
    if (panelOpen) setDetailsPopover(false);
  }, [panelOpen]);
  // A small window has room for the sidebar drawer or the panel, not both: opening one closes the other.
  useEffect(() => {
    if (panelOpen && layout === "small") useSidebarDrawer.getState().close();
  }, [panelOpen, layout]);
  const panelPresent = useLingering(panelOpen, motion.exitMs);
  // A pane that is already open when the thread appears stays still; later opens and closes slide.
  const paneMoves = useSettledAfter(thread ? id : null);

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
  // The panel takes the thread's place on the phone and when maximised; otherwise it docks or floats over it.
  const swapped = panelOpen && (phone || maximized);
  const terminalTakesOver = terminalOpen && layout === "phone";
  const detailsFit = layout === "xwide" || !panelOpen;
  // Ledger keeps the details rail beside the thread on a wide window. Otherwise the card sits at the top
  // of the side panel while it is open (also over the thread, on medium and small windows), and opens
  // as a popover under the Details button while it is closed.
  const rail = ledger && wide;
  const inPanel = !rail && panelOpen && !phone;
  const detailsShown = rail ? detailsPref && detailsFit : inPanel ? detailsPref : detailsPopover;
  const toggleDetails = () => (rail || inPanel ? toggleDetailsPref() : setDetailsPopover(!detailsPopover));

  const beforeSend = async () => {
    if (!hero) return;
    recordStart();
    flushSync(() => setDocked(true));
    await composerSettled();
  };

  return (
    <div className="thread-layout">
      <ProjectActionShortcuts threadId={id} />
      <FavoriteEditorShortcut threadId={id} />
      <section
        className="thread-main"
        hidden={swapped}
        aria-label={thread.title}
        data-details={rail && detailsShown ? "reserved" : undefined}
        data-chat-width={chatWidth}
      >
        <TopBar
          thread={thread}
          project={project}
          detailsShown={detailsShown}
          detailsPopup={!rail && !inPanel}
          paneShown={panelOpen && !phone}
          onToggleDetails={toggleDetails}
          onTogglePane={() => setPanelOpen(!panelOpen)}
        />
        {finding ? <ThreadFind onClose={() => setFinding(false)} /> : null}
        <div className="thread-stage" hidden={terminalTakesOver} data-hero={hero || undefined} data-connection={connection ?? undefined}>
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
              header={<LedgerPin threadId={id} />}
                footer={
                  <>
                    <GoalLine thread={thread} canPause={engine?.capabilities.goal_control === true} />
                    <RunStatusLine thread={thread} />
                  </>
                }
            />
          )}
          <WorktreeSetupCard thread={thread} />
          <ThreadErrorBanner thread={thread} />
          <LimitBanner thread={thread} />
          <ServiceDownBanner />
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
        <TerminalDrawer threadId={id} open={terminalOpen} moves={paneMoves} onClose={() => togglePanel("terminal")} />
        {rail && detailsShown ? <DetailsCard thread={thread} engine={engine} compact={false} onClose={toggleDetailsPref} /> : null}
        {!rail && !inPanel && detailsPopover ? (
          <DetailsPopover thread={thread} engine={engine} compact={phone} onClose={() => setDetailsPopover(false)} />
        ) : null}
      </section>
      {panelPresent ? (
        <SurfacePane
          thread={thread}
          mode={phone ? "sheet" : overlays ? "overlay" : "docked"}
          closing={!panelOpen}
          moves={paneMoves}
          maximized={maximized}
          details={inPanel && detailsPref ? <DetailsCard thread={thread} engine={engine} compact={false} onClose={toggleDetailsPref} /> : null}
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
