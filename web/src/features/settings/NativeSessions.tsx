import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { EngineStatus } from "../../api/types";
import type { AcpNativeSession } from "../../generated/AcpNativeSession";
import type { AcpNativeSessionImported } from "../../generated/AcpNativeSessionImported";
import type { AcpNativeSessionPage } from "../../generated/AcpNativeSessionPage";
import type { AcpSessionCapabilities } from "../../generated/AcpSessionCapabilities";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { SettingRow } from "../../ui/SettingRow";

const base = (engine: string) => `/api/engines/${encodeURIComponent(engine)}/native-sessions`;

/** An ACP agent's own saved conversations, offered only when it says it can list them. */
export function NativeSessions({ engine }: { engine: EngineStatus }) {
  const projects = useWorkspace((state) => state.projects.data) ?? [];
  const toast = useUi((state) => state.pushToast);
  const [caps, setCaps] = useState<AcpSessionCapabilities | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AcpNativeSession[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AcpNativeSession | null>(null);
  const epoch = useRef(0);
  const active = engine.tier === "acp" && engine.installed;
  const project = projectId ?? projects[0]?.id ?? null;

  useEffect(() => {
    epoch.current += 1;
    setCaps(null); setSessions([]); setNext(null); setBusy(null);
    if (!active) return;
    const abort = new AbortController();
    request<AcpSessionCapabilities>("GET", `${base(engine.id)}/capabilities`, undefined, abort.signal).then(setCaps, () => undefined);
    return () => abort.abort();
  }, [engine.id, active]);

  if (!active || !caps?.can_list) return null;
  const canImport = caps.can_load || caps.can_resume;
  const fail = (title: string, failure: unknown) => toast(`${title}: ${toFailure(failure).message}`);

  const load = async (cursor?: string) => {
    if (!project || busy) return;
    const mine = epoch.current;
    setBusy("list");
    try {
      const query = `?project_id=${encodeURIComponent(project)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await request<AcpNativeSessionPage>("GET", `${base(engine.id)}${query}`);
      if (mine !== epoch.current) return;
      setSessions((current) => (cursor ? [...current, ...page.sessions] : page.sessions));
      setNext(page.next_cursor);
    } catch (failure) {
      if (mine === epoch.current) fail("Could not list ACP sessions", failure);
    } finally {
      if (mine === epoch.current) setBusy(null);
    }
  };
  const importSession = async (session: AcpNativeSession) => {
    if (!project || busy) return;
    const mine = epoch.current;
    setBusy(session.session_id);
    try {
      const done = await request<AcpNativeSessionImported>("POST", `${base(engine.id)}/import`, {
        project_id: project, session_id: session.session_id,
        ...(session.title ? { title: session.title } : {}), ...(session.updated_at ? { updated_at: session.updated_at } : {}),
      });
      if (mine !== epoch.current) return;
      setSessions((current) => current.map((row) => (row.session_id === session.session_id ? { ...row, imported_thread_id: done.thread_id } : row)));
      toast(done.imported ? "ACP session imported" : "ACP session already imported");
    } catch (failure) {
      if (mine === epoch.current) fail("Could not import ACP session", failure);
    } finally {
      if (mine === epoch.current) setBusy(null);
    }
  };
  const remove = async (session: AcpNativeSession) => {
    if (!project) return;
    const mine = epoch.current;
    setBusy(session.session_id);
    try {
      await request("POST", `${base(engine.id)}/delete`, { project_id: project, session_id: session.session_id });
      if (mine !== epoch.current) return;
      setSessions((current) => current.filter((row) => row.session_id !== session.session_id));
      toast("ACP session deleted");
    } finally {
      if (mine === epoch.current) setBusy(null);
    }
  };

  return (
    <div className="native-sessions">
      <SettingRow title="Native sessions" description={projects.length === 0 ? "Add a project before importing sessions." : "Resume agent-owned conversations as threads."}>
        {projects.length > 0 ? (
          <>
            <select aria-label="Project for ACP sessions" value={project ?? ""} disabled={busy !== null}
              onChange={(event) => { epoch.current += 1; setProjectId(event.target.value); setSessions([]); setNext(null); }}>
              {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
            <Button small disabled={busy !== null || !project} onClick={() => void load()}>
              {busy === "list" ? "Loading" : sessions.length === 0 ? "List sessions" : "Refresh"}
            </Button>
          </>
        ) : null}
      </SettingRow>
      {sessions.length > 0 ? (
        <ul className="native-session-list">
          {sessions.map((session) => (
            <li key={session.session_id}>
              <div className="native-session-text">
                <span>{session.title ?? session.session_id}</span>
                <code>{session.session_id}</code>
              </div>
              <Button small disabled={!canImport || session.imported_thread_id !== null || busy !== null} onClick={() => void importSession(session)}>
                {session.imported_thread_id !== null ? "Imported" : busy === session.session_id ? "Importing" : "Import"}
              </Button>
              {caps.can_delete ? (
                <Button small tone="danger" disabled={session.imported_thread_id !== null || busy !== null} onClick={() => setDeleting(session)}>
                  {busy === session.session_id ? "Deleting" : "Delete"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {next !== null ? <Button small disabled={busy !== null} onClick={() => void load(next)}>{busy === "list" ? "Loading" : "Load more"}</Button> : null}
      {deleting ? (
        <ConfirmDialog title="Delete native session?" confirmLabel="Delete" tone="danger" onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)}>
          <p>Permanently delete native ACP session “{deleting.title ?? deleting.session_id}”?</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
