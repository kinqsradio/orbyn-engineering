import { ArrowUp, Download, Folder, GitBranch, Plus, Search, SquareCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, request } from "../../api/client";
import type { PreferenceView, Project } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate, routeHref } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { FolderBrowser } from "../onboarding/FolderBrowser";
import { dropTrailingSlash, expandHome, replaceHomePrefix, shortenHome, splitPath, withSlash } from "./pathInput";
import { trackClone } from "./CloneJobs";
import "./addProject.css";

export type AddProjectView = "folders" | "new" | "clone";

/** An `owner/name` on GitHub is a clone address too; anything else goes to Git as typed. */
export function cloneAddress(text: string): string {
  const typed = text.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(typed) && !/^\.{1,2}\//.test(typed) ? `https://github.com/${typed}.git` : typed;
}

/** The base directory setting, when the person has chosen one. */
function useBaseDirectory(): string | null {
  const preferences = useAsync("add-project-base-directory", (signal) => request<PreferenceView[]>("GET", "/api/preferences", undefined, signal));
  const value = (Array.isArray(preferences.data) ? preferences.data : []).find((view) => view.key === "add_project_base_directory")?.value;
  return typeof value === "string" && value.trim() ? value : null;
}

function useFinish(onClose: () => void, onAdded?: (project: Project) => void) {
  const putProject = useWorkspace((state) => state.putProject);
  const refreshThreads = useWorkspace((state) => state.refreshThreads);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  return (project: Project) => {
    putProject(project);
    void refreshThreads(project.id);
    void refreshManaged();
    // Where the add is one step of a longer flow, the caller keeps the person where they are.
    if (onAdded) {
      onAdded(project);
      return;
    }
    onClose();
    navigate(
      project.trusted
        ? { name: "new", projectId: project.id }
        : { name: "trust", projectId: project.id, threadId: null },
    );
  };
}

function Folders({
  onNew,
  onClone,
  onBrowse,
  onClose,
  added,
  onAdded,
}: {
  onNew(): void;
  onClone(): void;
  onBrowse(): void;
  onClose(): void;
  added: readonly Project[];
  onAdded?(project: Project): void;
}) {
  const finish = useFinish(onClose, onAdded);
  const [home, setHome] = useState<string | null>(null);
  const [value, setValue] = useState("~/");
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    api.browse(null, abort.signal).then(
      (listing) => setHome(listing.path),
      (failure: unknown) => {
        if (!abort.signal.aborted) setError(toFailure(failure).message);
      },
    );
    return () => abort.abort();
  }, []);

  const { dir, leaf } = splitPath(value);
  const expanded = home === null ? null : expandHome(dir, home);
  const listing = useAsync(`palette-browse:${expanded ?? ""}`, (signal) =>
    expanded === null ? Promise.resolve(null) : api.browse(expanded, signal),
  );
  const entries = useMemo(() => {
    const needle = leaf.toLowerCase();
    return (listing.data?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [listing.data, leaf]);
  const parent = listing.data?.parent ?? null;
  const folderRows = entries.length + (parent ? 1 : 0);
  const actions = [
    { key: "new", run: onNew },
    { key: "clone", run: onClone },
    { key: "browse", run: onBrowse },
  ];
  const rows = folderRows + actions.length;

  const enter = (path: string) => {
    setValue(withSlash(home ? shortenHome(path, home) : path));
    setActive(-1);
    setError(null);
  };
  const add = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      finish(await api.addProject(path));
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };
  const addTyped = () => {
    const typed = value.trim();
    if (busy || (home === null && typed.startsWith("~"))) return;
    void add(dropTrailingSlash(expandHome(typed, home ?? "")));
  };
  const folderAt = (at: number) => {
    if (parent && at === 0) return parent;
    return entries[at - (parent ? 1 : 0)]?.path ?? null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      event.stopPropagation();
      onBrowse();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.min(rows - 1, Math.max(-1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active >= folderRows) actions[active - folderRows]?.run();
      else if (active >= 0) {
        const path = folderAt(active);
        if (path && (event.metaKey || event.ctrlKey)) void add(path);
        else if (path) enter(path);
      } else addTyped();
    }
  };
  const isMac = /mac/i.test(navigator.platform);

  return (
    <>
      <div className="palette-search">
        <Folder size={16} aria-hidden />
        <input
          autoFocus
          className="add-project-path"
          aria-label="Folder path"
          placeholder="Enter a folder path"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            setValue(replaceHomePrefix(event.target.value));
            setActive(-1);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {error ? (
        <p className="palette-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="palette-list">
        {listing.status === "error" ? <p className="sidebar-empty">{listing.error.message}</p> : null}
        {/* Until the home folder is known nothing was listed, so nothing is empty yet. */}
        {listing.status === "ready" && listing.data !== null && folderRows === 0 ? <p className="sidebar-empty">No folders here</p> : null}
        {added.length > 0 ? (
          <>
            <div className="palette-group">Added</div>
            {added.map((project) => (
              <div key={project.id} className="add-project-added">
                <SquareCheck size={14} aria-hidden />
                <span className="palette-title add-project-path-row">{home ? shortenHome(project.path, home) : project.path}</span>
                <span className="add-project-hint">{project.is_git ? "Git" : "Folder"}</span>
              </div>
            ))}
            <div className="add-project-sep" role="separator" />
          </>
        ) : null}
        {folderRows > 0 ? <div className="palette-group">Folders</div> : null}
        {parent ? (
          <button type="button" data-active={active === 0 || undefined} onMouseMove={() => setActive(0)} onClick={() => enter(parent)}>
            <ArrowUp size={16} aria-hidden />
            <span className="palette-title">..</span>
          </button>
        ) : null}
        {entries.map((entry, at) => {
          const row = at + (parent ? 1 : 0);
          return (
            <button
              key={entry.path}
              type="button"
              data-active={active === row || undefined}
              onMouseMove={() => setActive(row)}
              onClick={() => enter(entry.path)}
            >
              {entry.is_git ? <GitBranch size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
              <span className="palette-title add-project-path-row">{home ? shortenHome(entry.path, home) : entry.path}</span>
              <span className="add-project-hint" aria-hidden>
                {entry.is_git ? "Git" : "Folder"}
              </span>
            </button>
          );
        })}
        <div className="add-project-sep" role="separator" />
        {[
          { icon: <Plus size={16} aria-hidden />, title: "New project", hint: "README and first commit" },
          { icon: <Download size={16} aria-hidden />, title: "Clone a repository", hint: "Git URL or owner/name" },
          { icon: <Search size={16} aria-hidden />, title: "Browse this computer", hint: isMac ? "⌘O" : "Ctrl O" },
        ].map((action, at) => (
          <button
            key={action.title}
            type="button"
            data-active={active === folderRows + at || undefined}
            onMouseMove={() => setActive(folderRows + at)}
            onClick={actions[at]?.run}
          >
            {action.icon}
            <span className="palette-title">{action.title}</span>
            <span className="add-project-hint add-project-hint-prose">{action.hint}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** One field, Cancel and the confirm: the design's New project and Clone dialogs. */
function AddDialog({
  title,
  label,
  confirm,
  mono,
  hint,
  submit,
  onCancel,
}: {
  title: string;
  label: string;
  confirm: string;
  mono?: boolean;
  hint: ReactNode;
  submit(value: string): Promise<void>;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const send = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit(text);
    } catch (failure) {
      if (live.current) setError(toFailure(failure).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      busy={busy}
      className="add-project-dialog"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" busy={busy} disabled={!value.trim()} onClick={() => void send()}>
            {confirm}
          </Button>
        </>
      }
    >
      <form
        className="add-project-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="add-project-field">{label}</label>
        <input
          id="add-project-field"
          className={mono ? "dialog-field dialog-field-mono" : "dialog-field"}
          data-dialog-focus
          value={value}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setValue(event.target.value)}
        />
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : hint ? (
          <span className="add-project-note">{hint}</span>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Adding a project: a path to add in place, a new empty folder or a clone. Folders stay where they are. */
export function AddProjectPalette({
  initialView = "folders",
  onClose,
  onSubdialog,
  added = [],
  onAdded,
}: {
  initialView?: AddProjectView;
  /** Projects this flow has already added, listed under "Added". */
  added?: readonly Project[];
  /** Keeps the person in place after an add, instead of opening the project. */
  onAdded?(project: Project): void;
  onClose(): void;
  /** True while a dialog sits over the palette, which hides itself meanwhile. */
  onSubdialog(open: boolean): void;
}) {
  const [view, setView] = useState<AddProjectView>(initialView);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const finishAdd = useFinish(onClose, onAdded);
  // A dialog that added something is done; where the flow goes on, the palette is what is left.
  const finish = (project: Project) => {
    setView("folders");
    setBrowsing(false);
    finishAdd(project);
  };
  const base = useBaseDirectory();
  const home = useAsync("add-project-home", (signal) => api.browse(null, signal)).data?.path ?? null;
  const sub = view !== "folders" || browsing;
  useEffect(() => {
    onSubdialog(sub);
    return () => onSubdialog(false);
  }, [sub, onSubdialog]);
  // Closing a dialog opened from outside the palette (the empty home) ends the add flow.
  const cancel = () => (initialView === "folders" ? setView("folders") : onClose());
  return (
    <>
      <Folders onNew={() => setView("new")} onClone={() => setView("clone")} onBrowse={() => setBrowsing(true)} onClose={onClose} added={added} onAdded={onAdded} />
      {view === "new" ? (
        <AddDialog
          title="New project"
          label="Name"
          confirm="Create project"
          hint={
            <>
              {base ? (
                <>
                  Created in <span className="mono">{base}</span>, your base directory.{" "}
                  <a className="add-project-link" href={routeHref({ name: "settings", section: "general" })} onClick={onClose}>
                    Change
                  </a>
                  <br />
                </>
              ) : null}
              Creates a folder with a README and a first commit, so worktrees work.
            </>
          }
          submit={async (name) =>
            // With a base directory chosen the folder is made there; without one the service picks.
            finish(await api.createProject(name, base && home ? `${dropTrailingSlash(expandHome(base, home))}/${name}` : undefined))
          }
          onCancel={cancel}
        />
      ) : null}
      {view === "clone" ? (
        <AddDialog
          title="Clone a repository"
          label="Git URL or owner/name"
          confirm="Clone"
          mono
          hint={
            <>
              Any Git URL works, or an owner/name on GitHub.{" "}
              {base ? (
                <>
                  It is cloned into <span className="mono">{base}</span>;{" "}
                </>
              ) : (
                "It is cloned into your base directory; "
              )}
              progress shows in the sidebar until it finishes.
            </>
          }
          submit={async (url) => {
            const job = await api.startClone(cloneAddress(url));
            if (onAdded) setView("folders");
            else onClose();
            trackClone(job, finish);
          }}
          onCancel={cancel}
        />
      ) : null}
      {browsing ? (
        <Dialog title="Browse this computer" onClose={() => setBrowsing(false)} className="add-project-dialog">
          {browseError ? (
            <p className="field-error" role="alert">
              {browseError}
            </p>
          ) : null}
          <FolderBrowser
            actionLabel="Add this folder"
            onChoose={(path) => {
              setBrowseError(null);
              api.addProject(path).then(finish, (failure: unknown) => setBrowseError(toFailure(failure).message));
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}
