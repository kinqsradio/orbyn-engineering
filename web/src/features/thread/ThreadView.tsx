import {
  ArrowLeft,
  CircleStop,
  EllipsisVertical,
  GitBranch,
  PanelRight,
  ShieldAlert,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useLayoutWidth } from "../../lib/useLayout";
import { toFailure } from "../../lib/useAsync";
import { navigate, routeHref } from "../../state/route";
import { useThreadLogs, useThreadStream } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { Button, IconButton, LinkButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { ContextPanel } from "../panels/ContextPanel";
import { CONTEXT_TABS } from "../panels/tabs";
import { ApprovalsLink } from "../workspace/ApprovalsLink";
import { RunStatePill, threadRunState } from "../workspace/RunState";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

function PanelToggles() {
  const open = useUi((state) => state.panelOpen);
  const tab = useUi((state) => state.panelTab);
  const toggle = useUi((state) => state.togglePanel);
  const layout = useLayoutWidth();
  if (layout === "narrow") {
    // The panel has its own tabs, so one way in is enough on a phone.
    return (
      <IconButton label="Open diff, terminal and activity" onClick={() => toggle(tab)}>
        <PanelRight size={16} aria-hidden />
      </IconButton>
    );
  }
  return (
    <div className="panel-toggles" role="group" aria-label="Context panel">
      {CONTEXT_TABS.map(({ id, label, icon: Icon }) => (
        <IconButton key={id} label={label} pressed={open && tab === id} onClick={() => toggle(id)}>
          <Icon size={16} aria-hidden />
        </IconButton>
      ))}
    </div>
  );
}

function ThreadMenu({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dropThread = useWorkspace((state) => state.dropThread);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && menu.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={menu}>
      <IconButton label="Thread actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EllipsisVertical size={16} aria-hidden />
      </IconButton>
      {open ? (
        <div className="menu">
          <Button
            tone="quiet"
            small
            icon={<Trash2 size={16} aria-hidden />}
            disabled={thread.active_run !== null}
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            Delete thread
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title="Delete thread?"
          confirmLabel="Delete thread"
          tone="danger"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await api.deleteThread(thread.id);
            dropThread(thread);
            navigate({ name: "home" });
          }}
        >
          <p>
            “{thread.title}” and its log are removed from Orbyn. Files on disk and any worktree stay
            where they are.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function CancelRun({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelRun(runId);
      void refreshAll();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button small busy={busy} icon={<CircleStop size={16} aria-hidden />} onClick={() => void cancel()}>
        <span>
          Cancel<span className="wide-only"> run</span>
        </span>
      </Button>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function ThreadHeader({ thread, profileName }: { thread: Thread; profileName: string | null }) {
  const engines = useWorkspace((state) => state.engines.data);
  const engine = engineById(engines, thread.engine);
  const state = threadRunState(thread);
  const layout = useLayoutWidth();

  return (
    <header className="thread-head">
      {layout === "narrow" ? (
        <a className="icon-btn" href={routeHref({ name: "home" })} aria-label="Back to threads" title="Back to threads">
          <ArrowLeft size={16} aria-hidden />
        </a>
      ) : null}
      <div className="thread-title">
        <h1 tabIndex={-1} data-page-title>
          {thread.title}
        </h1>
        <p className="thread-sub">
          <span>{engine?.name ?? thread.engine}</span>
          {thread.worktree ? (
            <span className="thread-branch" title={thread.worktree.path}>
              <GitBranch size={16} aria-hidden />
              {thread.worktree.branch}
            </span>
          ) : null}
          {profileName ? <span>{profileName}</span> : null}
        </p>
      </div>
      <div className="thread-state" role="status">
        {state ? <RunStatePill state={state} /> : null}
      </div>
      {thread.active_run ? <CancelRun runId={thread.active_run.id} /> : null}
      <div className="thread-actions">
        <PanelToggles />
        {layout === "narrow" ? <ApprovalsLink compact /> : null}
        <ThreadMenu thread={thread} />
      </div>
    </header>
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

export function ThreadView({ id }: { id: string }) {
  const thread = useWorkspace((state) => state.threads[id]);
  const missing = useWorkspace((state) => state.missingThreads[id]);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const engines = useWorkspace((state) => state.engines.data);
  const projects = useWorkspace((state) => state.projects.data);
  const setLastThread = useUi((state) => state.setLastThread);
  const panelOpen = useUi((state) => state.panelOpen);
  const closePanel = useUi((state) => state.closePanel);
  const layout = useLayoutWidth();
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

  const engine = engineById(engines, thread.engine);
  const unmanaged = engine !== null && !engine.capabilities.managed;
  const swapped = panelOpen && layout !== "wide";

  return (
    <div className="thread-layout" data-panel={panelOpen ? "open" : "closed"}>
      <section className="thread-main" hidden={swapped} aria-label={thread.title}>
        <ThreadHeader thread={thread} profileName={profileName} />
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
        />
        <Composer thread={thread} engine={engine} profileName={profileName} />
      </section>
      {panelOpen ? (
        <ContextPanel
          thread={thread}
          overlay={layout !== "wide"}
          onReturn={closePanel}
        />
      ) : null}
    </div>
  );
}
