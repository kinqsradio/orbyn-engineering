import { useState } from "react";
import { request } from "../../api/client";
import type { HistoryScan } from "../../generated/HistoryScan";
import type { HistorySession } from "../../generated/HistorySession";
import type { HistorySessionImported } from "../../generated/HistorySessionImported";
import { fullTime } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { settingsLabel } from "./settingsSearch";

const ENGINE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * Claude and Codex conversations from their own history folders. Scanning waits for
 * the person to ask, and an import resumes the engine's session in a trusted project.
 */
export function HistoryImport() {
  const pushToast = useUi((state) => state.pushToast);
  const [scan, setScan] = useState<HistoryScan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const find = async () => {
    setBusy("scan");
    try {
      setScan(await request<HistoryScan>("GET", "/api/history/sessions"));
    } catch (failure) {
      pushToast(`Couldn't read agent history: ${toFailure(failure).message}`);
    } finally {
      setBusy(null);
    }
  };
  const importSession = async (session: HistorySession) => {
    setBusy(`${session.engine}:${session.session_id}`);
    try {
      const done = await request<HistorySessionImported>("POST", "/api/history/import", { engine: session.engine, session_id: session.session_id });
      await useWorkspace.getState().refreshAll();
      navigate({ name: "thread", id: done.thread_id });
    } catch (failure) {
      pushToast(`Couldn't import the session: ${toFailure(failure).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingGroup title="Agent history">
      <SettingRow
        title={settingsLabel("providers-agent-history")}
        description="Finds Claude and Codex conversations saved on this computer. Only each one's folder and first prompt are read."
      >
        <Button small disabled={busy !== null} onClick={() => void find()}>
          {scan ? "Scan again" : "Find conversations"}
        </Button>
      </SettingRow>
      {scan && scan.sessions.length === 0 ? <p className="setting-line-desc" role="status">No saved conversations found.</p> : null}
      {scan?.sessions.map((session) => {
        const key = `${session.engine}:${session.session_id}`;
        return (
          <SettingRow
            key={key}
            title={session.title}
            description={`${ENGINE_NAMES[session.engine] ?? session.engine} · ${session.cwd} · ${fullTime(session.updated_at)}`}
          >
            {session.thread_id ? (
              <Button small tone="quiet" onClick={() => navigate({ name: "thread", id: session.thread_id ?? "" })}>
                Open
              </Button>
            ) : session.importable ? (
              <Button small disabled={busy !== null} onClick={() => void importSession(session)}>
                {busy === key ? "Importing…" : "Import"}
              </Button>
            ) : (
              <Pill tone="warn" title="Add and trust this folder as a project to import it.">
                {session.project_id ? "Untrusted project" : "No project"}
              </Pill>
            )}
          </SettingRow>
        );
      })}
      {scan?.truncated ? <p className="setting-line-desc">Only the newest conversations are listed.</p> : null}
    </SettingGroup>
  );
}
