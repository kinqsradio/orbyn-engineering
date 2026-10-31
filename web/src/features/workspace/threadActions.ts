import { api } from "../../api/client";
import type { Thread, UpdateThread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { pullsApi } from "../pulls/pullsApi";
import { threadToken } from "../thread/skillMention";
import { navigate, parseRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { arrangeThreads, threadsFlat } from "./groups";
import { pushUndo } from "./threadUndo";

const openThreadId = () => {
  const route = parseRoute(window.location.hash);
  return route.name === "thread" ? route.id : null;
};

const toastFailure = (what: string, failure: unknown) =>
  useUi.getState().pushToast(`Couldn't ${what}. ${toFailure(failure).message}`);

const patch = async (thread: Thread, body: UpdateThread) => {
  const next = await api.patchThread(thread.id, body);
  useWorkspace.getState().putThread(next);
  return next;
};

/** Leaves a thread that has just gone to a shelf, for the next row in the list. */
function moveOff(ids: ReadonlySet<string>) {
  const open = openThreadId();
  if (!open || !ids.has(open)) return;
  const all = Object.values(useWorkspace.getState().threads);
  const rows = threadsFlat(arrangeThreads(all, Date.now(), open));
  const from = rows.findIndex((thread) => thread.id === open);
  const after = [...rows.slice(from + 1), ...rows.slice(0, Math.max(from, 0))];
  const next = after.find(
    (thread) => !ids.has(thread.id) && !thread.lifecycle?.settled_at && !thread.lifecycle?.snoozed_until,
  );
  navigate(next ? { name: "thread", id: next.id } : { name: "new", projectId: null });
}

/** What restores a thread after settling, which also ends its pin and snooze. */
function restoreSettled(thread: Thread): UpdateThread {
  const lifecycle = thread.lifecycle;
  return {
    settled: false,
    ...(lifecycle?.pinned_at ? { pinned: true } : {}),
    ...(lifecycle?.snoozed_until ? { snoozed_until: lifecycle.snoozed_until } : {}),
  };
}

async function each(
  threads: readonly Thread[],
  what: string,
  body: (thread: Thread) => UpdateThread,
  after?: (thread: Thread) => void,
) {
  await Promise.all(
    threads.map((thread) =>
      patch(thread, body(thread)).then(
        () => after?.(thread),
        (failure: unknown) => toastFailure(what, failure),
      ),
    ),
  );
}

export function settleThreads(threads: readonly Thread[]) {
  const moving = threads.filter((thread) => !thread.lifecycle?.settled_at);
  moveOff(new Set(moving.map((thread) => thread.id)));
  return each(moving, "settle the thread", () => ({ settled: true }), (thread) =>
    pushUndo("Settled", () => patch(thread, restoreSettled(thread)).catch((f: unknown) => toastFailure("undo", f))),
  );
}

export const unsettleThreads = (threads: readonly Thread[]) =>
  each(threads, "un-settle the thread", () => ({ settled: false }));

export function snoozeThreads(threads: readonly Thread[], until: Date) {
  moveOff(new Set(threads.map((thread) => thread.id)));
  const snoozed_until = until.toISOString();
  return each(threads, "snooze the thread", () => ({ snoozed_until }), (thread) =>
    pushUndo("Snoozed", () => patch(thread, { wake: true }).catch((f: unknown) => toastFailure("undo", f))),
  );
}

export const dismissWoke = (thread: Thread) =>
  each([thread], "dismiss that", () => ({ dismiss_woke: true }));

export const wakeThreads = (threads: readonly Thread[]) =>
  each(threads, "wake the thread", () => ({ wake: true }));

export const pinThreads = (threads: readonly Thread[]) =>
  each(threads, "pin the thread", () => ({ pinned: true }));

const declined = (question: string) => !window.confirm(question);

export const unpinThreads = async (threads: readonly Thread[]) =>
  useUi.getState().confirmUnpin && declined("Unpin this thread?")
    ? undefined
    : each(threads, "unpin the thread", () => ({ pinned: false }), (thread) =>
    pushUndo("Unpinned", () => patch(thread, { pinned: true }).catch((f: unknown) => toastFailure("undo", f))),
  );

export function archiveThreads(threads: readonly Thread[]) {
  if (useUi.getState().confirmArchive && declined("Archive this thread?")) return undefined;
  moveOff(new Set(threads.map((thread) => thread.id)));
  return each(threads, "archive the thread", () => ({ archived: true }), (thread) =>
    pushUndo("Archived", () => patch(thread, { archived: false }).catch((f: unknown) => toastFailure("undo", f))),
  );
}

export const unarchiveThread = (thread: Thread) =>
  each([thread], "unarchive the thread", () => ({ archived: false }));

export const setUnread = (threads: readonly Thread[], unread: boolean) =>
  each(threads, "update the thread", () => ({ unread }));

export const setAutoSettle = (thread: Thread, choice: "enabled" | "disabled") =>
  each([thread], "update the thread", () => ({ auto_settle: choice }));

export const renameThread = (thread: Thread, title: string) =>
  each([thread], "rename the thread", () => ({ title }));

export function regenerateTitles(threads: readonly Thread[]) {
  return Promise.all(
    threads.map((thread) =>
      api.regenerateTitle(thread.id).then(
        (next) => useWorkspace.getState().putThread(next),
        (failure: unknown) => toastFailure("regenerate the title", failure),
      ),
    ),
  );
}

export async function deleteThreads(threads: readonly Thread[]) {
  moveOff(new Set(threads.map((thread) => thread.id)));
  await Promise.all(
    threads.map((thread) =>
      api.deleteThread(thread.id).then(
        () => useWorkspace.getState().dropThread(thread),
        (failure: unknown) => toastFailure("delete the thread", failure),
      ),
    ),
  );
}

/** Saves `ordered` for a section, showing it at once. Ids left out keep their place. */
export async function reorderThreads(ordered: readonly Thread[]) {
  const { putThread } = useWorkspace.getState();
  const all = Object.values(useWorkspace.getState().threads);
  const lowest = all.reduce((low, thread) => Math.min(low, thread.lifecycle?.position ?? 0), 0);
  ordered.forEach((thread, index) => {
    const current = useWorkspace.getState().threads[thread.id] ?? thread;
    if (current.lifecycle) {
      putThread({
        ...current,
        lifecycle: { ...current.lifecycle, position: lowest - ordered.length + index },
      });
    }
  });
  try {
    await api.reorderThreads(ordered.map((thread) => thread.id));
  } catch (failure) {
    toastFailure("save the order", failure);
    await useWorkspace.getState().refreshAll();
  }
}

/** The folder stays where it is and becomes a project, with every thread in it. */
export async function turnIntoProject(thread: Thread) {
  try {
    const project = await api.adoptScratch(thread.id);
    const { putProject, refreshThreads } = useWorkspace.getState();
    putProject(project);
    await refreshThreads(project.id);
  } catch (failure) {
    toastFailure("turn it into a project", failure);
  }
}

export async function copyText(text: string, done: string) {
  const { pushToast } = useUi.getState();
  try {
    await navigator.clipboard.writeText(text);
    pushToast(done);
  } catch {
    pushToast("Couldn't copy.");
  }
}

/** The thread's pull request if it has one, otherwise a link that pastes as a thread chip. */
export async function copyReference(thread: Thread) {
  const pulls = await pullsApi.linked(thread.id).catch(() => []);
  const first = pulls[0];
  if (first) await copyText(first.url, `Copied #${first.number}`);
  else await copyText(threadToken(thread.id, thread.title), "Copied thread reference");
}
