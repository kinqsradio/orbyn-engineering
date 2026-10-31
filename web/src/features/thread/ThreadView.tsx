import {
  ArrowLeft,
  CircleDashed,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Rows3,
  ShieldAlert,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Project, RunState, Thread } from "../../api/types";
import { elapsed, runStateLabels } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { useLayoutWidth } from "../../lib/useLayout";
import { useNow } from "../../lib/useNow";
import { routeHref } from "../../state/route";
import { useThreadLogs, useThreadStream } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { ProjectBadge } from "../../ui/badges";
import { IconButton, LinkButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { ContextPanel } from "../panels/ContextPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { ApprovalsLink } from "../workspace/ApprovalsLink";
import { threadRunState } from "../workspace/RunState";
import { Composer } from "./Composer";
import { DetailsCard } from "./DetailsCard";
import { runningTools } from "./timeline";
import { Transcript } from "./Transcript";

function TopBar({
  thread,
  project,
  detailsShown,
  onToggleDetails,
}: {
  thread: Thread;
  project: Project | null;
  detailsShown: boolean;
  onToggleDetails(): void;
}) {
  const layout = useLayoutWidth();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const diffOpen = useUi((state) => state.panelOpen);
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
        {narrow ? <ApprovalsLink /> : null}
        <IconButton label="Details" pressed={detailsShown} onClick={onToggleDetails}>
          <Rows3 size={16} aria-hidden />
        </IconButton>
        {narrow ? null : (
          <>
            <IconButton label="Terminal" pressed={terminalOpen} onClick={() => togglePanel("terminal")}>
              <PanelBottom size={16} aria-hidden />
            </IconButton>
            <IconButton label="Diff" pressed={diffOpen} onClick={() => togglePanel("diff")}>
              <PanelRight size={16} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

const statusSentence = (state: RunState, tools: number): string => {
  if (state === "awaiting_approval") return "Waiting for your approval";
  if (state === "running" && tools > 0) return tools === 1 ? "Waiting on 1 tool" : `Waiting on ${tools} tools`;
  return runStateLabels[state];
};

/** The server's run state, with the Stop action, at the end of the conversation. */
function RunStatusLine({ thread }: { thread: Thread }) {
  const state = threadRunState(thread);
  const active = thread.active_run;
  const log = useThreadLogs((store) => store.logs[thread.id]);
  const tools = useMemo(() => (active ? runningTools(log?.items ?? []) : []), [log, active]);
  const now = useNow(active !== null);
  const refreshAll = useWorkspace((store) => store.refreshAll);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state) return <div className="thread-state" role="status" />;
  if (!active) {
    // Failed and cancelled runs already have a notice in the log.
    return (
      <div className="thread-state" role="status">
        <span className={state === "interrupted" ? "run-status" : "sr-only"}>{runStateLabels[state]}</span>
      </div>
    );
  }

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelRun(active.id);
      void refreshAll();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread-state run-status-row" role="status">
      <CircleDashed size={16} aria-hidden className={state === "awaiting_approval" ? "tone-warn" : undefined} />
      <span className="run-status">{statusSentence(state, tools.length)}</span>
      {tools.length > 0 ? (
        <span className="run-status-detail">{tools.map((tool) => tool.name).join(", ")}</span>
      ) : (
        <span className="run-status-detail">{elapsed(active.started_at, now)}</span>
      )}
      <button type="button" className="text-action" disabled={busy} onClick={() => void stop()}>
        Stop
      </button>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function useProfileName(profileId: string | null): string | null {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!profileId) return;
    const abort = new AbortController();
    api.profiles(abort.signal).then(
      (profiles) => setNames(Object.fromEntries(profiles.map((p) => [p.id, p.name]))),
      () => undefined,
    );
    return () => abort.abort();
  }, [profileId]);
  return profileId ? (names[profileId] ?? null) : null;
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
      <TerminalPanel threadId={threadId} />
      <IconButton label="Close terminal" className="drawer-close" onClick={onClose}>
        <X size={14} aria-hidden />
      </IconButton>
    </section>
  );
}

export function ThreadView({ id }: { id: string }) {
  const thread = useWorkspace((state) => state.threads[id]);
  const missing = useWorkspace((state) => state.missingThreads[id]);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const engines = useWorkspace((state) => state.engines.data);
  const projects = useWorkspace((state) => state.projects.data);
  const setLastThread = useUi((state) => state.setLastThread);
  const panelOpen = useUi((state) => state.panelOpen);
  const closePanel = useUi((state) => state.closePanel);
  const detailsPref = useUi((state) => state.detailsOpen);
  const toggleDetailsPref = useUi((state) => state.toggleDetails);
  const terminalOpen = useUi((state) => state.terminalOpen);
  const togglePanel = useUi((state) => state.togglePanel);
  const layout = useLayoutWidth();
  const [detailsOverlay, setDetailsOverlay] = useState(false);
  useThreadStream(id);

  useEffect(() => {
    setLastThread(id);
    void refreshThread(id);
  }, [id, refreshThread, setLastThread]);

  const profileName = useProfileName(thread?.skill_profile ?? null);
  const project = useMemo(
    () => projects?.find((p) => p.id === thread?.project_id) ?? null,
    [projects, thread?.project_id],
  );

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

  const wide = layout === "wide";
  const engine = engineById(engines, thread.engine);
  const unmanaged = engine !== null && !engine.capabilities.managed;
  const swapped = panelOpen && !wide;
  const terminalTakesOver = terminalOpen && layout === "narrow";
  const detailsShown = wide ? detailsPref && !panelOpen : detailsOverlay;

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
          onToggleDetails={() => (wide ? toggleDetailsPref() : setDetailsOverlay(!detailsOverlay))}
        />
        <div className="thread-stage" hidden={terminalTakesOver}>
          <StreamBanner threadId={id} />
          {project && !project.trusted ? (
            <p className="banner banner-warn">
              <ShieldAlert size={16} aria-hidden />
              <span>This folder isn't trusted yet, so engines can't run here.</span>
              <a href={routeHref({ name: "trust", projectId: project.id, threadId: id })}>Review folder</a>
            </p>
          ) : null}
          {unmanaged ? (
            <p className="banner banner-warn">
              <ShieldAlert size={16} aria-hidden />
              {engine?.name} can't ask permission, so Orbyn can't gate its actions.
            </p>
          ) : null}
          <Transcript
            threadId={id}
            active={thread.active_run !== null}
            engineName={engine?.name ?? thread.engine}
            footer={<RunStatusLine thread={thread} />}
          />
          <Composer thread={thread} engine={engine} profileName={profileName} />
        </div>
        <TerminalDrawer threadId={id} open={terminalOpen} onClose={() => togglePanel("terminal")} />
        {detailsShown ? (
          <DetailsCard
            thread={thread}
            engine={engine}
            profileName={profileName}
            compact={!wide}
            onClose={() => setDetailsOverlay(false)}
          />
        ) : null}
      </section>
      {panelOpen ? <ContextPanel thread={thread} overlay={!wide} onReturn={closePanel} /> : null}
    </div>
  );
}
