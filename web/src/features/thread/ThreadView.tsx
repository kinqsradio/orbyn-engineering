import {
  ArrowLeft,
  Brain,
  CircleCheck,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Rows3,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { api } from "../../api/client";
import type { Project, RunState, Thread } from "../../api/types";
import { relativeTime, runStateLabels } from "../../lib/format";
import { useLingering, usePanelMotion } from "../../lib/panelAnimations";
import { isWide, useLayoutWidth } from "../../lib/useLayout";
import { routeHref } from "../../state/route";
import { useThreadLogs, useThreadStream } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { ProjectBadge } from "../../ui/badges";
import { IconButton, LinkButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SurfacePane } from "../panels/SurfacePane";
import { TerminalDrawerBody } from "../panels/TerminalDrawerBody";
import { threadRunState } from "../workspace/RunState";
import { Composer } from "./Composer";
import { DetailsCard } from "./DetailsCard";
import { composerSettled, useComposerDock } from "./heroTransition";
import { runningTools } from "./timeline";
import { ThreadFind } from "./ThreadFind";
import { Transcript } from "./Transcript";

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
          <p className="settled-note">
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

function StreamBanner({ threadId }: { threadId: string }) {
  const status = useThreadLogs((state) => state.streams[threadId]?.status);
  if (status !== "reconnecting") return null;
  return (
    <p className="banner banner-warn" role="status">
      <WifiOff size={16} aria-hidden />
      Reconnecting. The thread resumes from the last event.
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
  const layout = useLayoutWidth();
  const wide = isWide(layout);
  const [detailsOverlay, setDetailsOverlay] = useState(false);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFinding(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const maximized = useUi((state) => state.panelMaximized);
  const setMaximized = useUi((state) => state.setPanelMaximized);
  const [docked, setDocked] = useState(false);
  const stream = useThreadLogs((state) => state.streams[id]?.status);
  const hasContent = useThreadLogs(
    (state) => (state.logs[id]?.items.length ?? 0) > 0 || (state.prompts[id]?.length ?? 0) > 0,
  );
  const motion = usePanelMotion();
  useThreadStream(id);

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
      <section
        className="thread-main"
        hidden={swapped}
        aria-label={thread.title}
        data-details={wide && detailsShown ? "reserved" : undefined}
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
          <StreamBanner threadId={id} />
          {project && !project.trusted ? (
            <p className="banner banner-warn">
              <ShieldAlert size={16} aria-hidden />
              <span>This folder isn't trusted yet, so engines can't run here.</span>
              <a href={routeHref({ name: "trust", projectId: project.id, threadId: id })}>Review folder</a>
            </p>
          ) : null}
          {hero ? null : (
            <Transcript
              threadId={id}
              active={thread.active_run !== null}
                footer={<RunStatusLine thread={thread} />}
            />
          )}
          <div className="composer-lane">
            <div ref={mover} className="composer-group">
              <div className="composer-stack">
                {hero ? <DraftHero project={project} /> : null}
                <div ref={anchor}>
                  <Composer
                    thread={thread}
                    engine={engine}
                    beforeSend={beforeSend}
                    onSendFailed={() => setDocked(false)}
                    showContext={hero}
                  />
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
