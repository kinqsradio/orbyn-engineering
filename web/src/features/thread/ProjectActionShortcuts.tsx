import { useEffect, useRef } from "react";
import { request } from "../../api/client";
import type { ProjectFileView } from "../../api/types";
import { useCommand } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { parseRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { actionCommand, actionIdFromCommand } from "../../lib/actionCommand";
import { runProjectAction } from "./runProjectAction";

function useActionRunner(threadId: string) {
  const pending = useRef(new Set<string>());
  const epoch = useRef(0);
  useEffect(() => {
    const cancel = () => { epoch.current += 1; };
    window.addEventListener("hashchange", cancel);
    return () => { cancel(); window.removeEventListener("hashchange", cancel); };
  }, [threadId]);
  const activeThread = () => {
    const route = parseRoute(window.location.hash);
    return route.name === "thread" && route.id === threadId && !document.querySelector("dialog[open]");
  };
  const run = (id: string) => {
    const observed = epoch.current;
    const requestKey = `${observed}:${id}`;
    const active = () => {
      return epoch.current === observed && activeThread();
    };
    if (!active()) return false;
    if (pending.current.has(requestKey)) return true;
    pending.current.add(requestKey);
    void request<ProjectFileView>("GET", `/api/threads/${encodeURIComponent(threadId)}/scripts`).then(async (view) => {
      const script = view.scripts.find((entry) => entry.id === id);
      if (script && active()) await runProjectAction(threadId, script);
    }).catch((failure: unknown) => useUi.getState().pushToast(`Couldn't run that action. ${toFailure(failure).message}`))
      .finally(() => { pending.current.delete(requestKey); });
    return true;
  };
  return { run, activeThread };
}

function ActionShortcut({ id, run, activeThread }: { id: string; run(id: string): boolean; activeThread(): boolean }) {
  useCommand(actionCommand(id), () => run(id), activeThread);
  return null;
}

/** Register only actions available in this thread; unrelated project bindings stay inactive. */
export function ProjectActionShortcuts({ threadId }: { threadId: string }) {
  const scripts = useAsync(`action-shortcuts:${threadId}`, (signal) =>
    request<ProjectFileView>("GET", `/api/threads/${encodeURIComponent(threadId)}/scripts`, undefined, signal));
  const reload = scripts.reload;
  const { run, activeThread } = useActionRunner(threadId);
  useCommand("projectActions.pending", (command) => {
    if (scripts.status === "ready" && !scripts.refreshing) return false;
    const id = command && actionIdFromCommand(command);
    return id ? run(id) : false;
  }, (command) => activeThread() && (scripts.status !== "ready" || scripts.refreshing)
    && Boolean(command && actionIdFromCommand(command)));
  useCommand("projectActions.reload", reload);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return scripts.data?.scripts.map((script) => script.id ? <ActionShortcut key={script.id} id={script.id} run={run} activeThread={activeThread} /> : null);
}
