import { ArrowLeft, ArrowUp, Folder, FolderGit2, FolderPlus, GitBranch, Link } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";

type View = "sources" | "browse" | "new" | "clone";

const CLONE_POLL_MS = 1000;

function useFinish(onClose: () => void) {
  const putProject = useWorkspace((state) => state.putProject);
  const refreshThreads = useWorkspace((state) => state.refreshThreads);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  return (project: Project) => {
    putProject(project);
    void refreshThreads(project.id);
    void refreshManaged();
    onClose();
    navigate(
      project.trusted
        ? { name: "new", projectId: project.id }
        : { name: "trust", projectId: project.id, threadId: null },
    );
  };
}

/** A clone runs in the background and lands wherever the person is by then. */
async function followClone(id: string, onDone: (project: Project) => void) {
  const { pushToast } = useUi.getState();
  pushToast("Cloning project");
  for (;;) {
    await new Promise((done) => setTimeout(done, CLONE_POLL_MS));
    const jobs = await api.clones().catch(() => null);
    const job = jobs?.find((entry) => entry.id === id);
    if (!job) return;
    if (job.state === "running") continue;
    if (job.state === "done" && job.project) onDone(job.project);
    else if (job.state === "failed") pushToast(`Clone failed. ${job.error ?? ""}`.trim());
    return;
  }
}

const SEP = /[\\/]/;

const lastSep = (value: string) => Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

export function splitPath(value: string): { dir: string; leaf: string } {
  const at = lastSep(value);
  return { dir: value.slice(0, at + 1), leaf: value.slice(at + 1) };
}

const withSlash = (path: string) => (SEP.test(path.slice(-1)) ? path : `${path}/`);

const shorten = (path: string, home: string) =>
  path === home ? "~/" : path.startsWith(withSlash(home)) ? `~/${path.slice(withSlash(home).length)}` : path;

const expand = (path: string, home: string) =>
  path === "~" || path.startsWith("~/") ? `${withSlash(home)}${path.slice(2)}` : path;

function Keys({ back, select }: { back: boolean; select: boolean }) {
  return (
    <footer className="palette-foot">
      <span>
        <kbd>↑</kbd>
        <kbd>↓</kbd> Navigate
      </span>
      {select ? (
        <span>
          <kbd>Enter</kbd> Select
        </span>
      ) : null}
      {back ? (
        <span>
          <kbd>Backspace</kbd> Back
        </span>
      ) : null}
      <span>
        <kbd>Esc</kbd> Close
      </span>
    </footer>
  );
}

function Head({
  value,
  placeholder,
  chip,
  label,
  onChange,
  onKeyDown,
  onBack,
}: {
  value: string;
  placeholder: string;
  chip: { label: string; onClick(): void; disabled?: boolean } | null;
  label: string;
  onChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  onBack(): void;
}) {
  return (
    <div className="palette-search">
      <button type="button" className="palette-back" aria-label="Back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden />
      </button>
      <input
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {chip ? (
        <button type="button" className="palette-chip" disabled={chip.disabled} onClick={chip.onClick}>
          {chip.label} <kbd>Enter</kbd>
        </button>
      ) : null}
    </div>
  );
}

function Sources({ onPick, onBack }: { onPick(view: View): void; onBack(): void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const items = useMemo(() => {
    const all: { view: View; title: string; description: string; icon: ReactNode; terms: string }[] = [
      {
        view: "new",
        title: "New project",
        description: "Start a new Git repository from a name",
        icon: <FolderGit2 size={16} aria-hidden />,
        terms: "new project create empty repository git init",
      },
      {
        view: "browse",
        title: "Local folder",
        description: "Browse a folder on disk",
        icon: <FolderPlus size={16} aria-hidden />,
        terms: "local folder directory browse",
      },
      {
        view: "clone",
        title: "Git URL",
        description: "Clone from a remote URL",
        icon: <Link size={16} aria-hidden />,
        terms: "git url clone remote",
      },
    ];
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((item) => item.terms.includes(needle)) : all;
  }, [query]);
  return (
    <>
      <Head
        value={query}
        placeholder="Search..."
        label="Search sources"
        chip={null}
        onBack={onBack}
        onChange={(value) => {
          setQuery(value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((active + step + items.length) % Math.max(items.length, 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = items[active];
            if (item) onPick(item.view);
          } else if (event.key === "Backspace" && query === "") {
            onBack();
          }
        }}
      />
      <div className="palette-list">
        {items.length === 0 ? <p className="sidebar-empty">No results</p> : null}
        {items.length > 0 ? <div className="palette-group">Sources</div> : null}
        {items.map((item, at) => (
          <button
            key={item.view}
            type="button"
            className="palette-two-line"
            data-active={at === active || undefined}
            onMouseMove={() => setActive(at)}
            onClick={() => onPick(item.view)}
          >
            {item.icon}
            <span className="palette-title">
              {item.title}
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>
      <Keys back select />
    </>
  );
}

function Browse({ onBack, onClose }: { onBack(): void; onClose(): void }) {
  const finish = useFinish(onClose);
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
  const expanded = home === null ? null : expand(dir, home);
  const listing = useAsync(`palette-browse:${expanded ?? ""}`, (signal) =>
    expanded === null ? Promise.resolve(null) : api.browse(expanded, signal),
  );
  const entries = useMemo(() => {
    const needle = leaf.toLowerCase();
    return (listing.data?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [listing.data, leaf]);
  const parent = listing.data?.parent ?? null;
  const rows = entries.length + (parent ? 1 : 0);

  const enter = (path: string) => {
    setValue(withSlash(home ? shorten(path, home) : path));
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
  const typedPath = () => {
    const typed = value.trim();
    if (home === null && typed.startsWith("~")) return null;
    const full = expand(typed, home ?? "");
    return full.length > 1 ? full.replace(/[\\/]$/, "") : full;
  };
  const addTyped = () => {
    const path = typedPath();
    if (path) void add(path);
  };

  const rowAt = (at: number) => {
    const shift = parent ? 1 : 0;
    if (parent && at === 0) return parent;
    return entries[at - shift]?.path ?? null;
  };

  return (
    <>
      <Head
        value={value}
        placeholder="Enter a folder path"
        label="Folder path"
        chip={{ label: "Add", onClick: addTyped, disabled: busy }}
        onBack={onBack}
        onChange={(next) => {
          setValue(next);
          setActive(-1);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(Math.min(rows - 1, Math.max(-1, active + step)));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const path = active >= 0 ? rowAt(active) : null;
            if (path && (event.metaKey || event.ctrlKey)) void add(path);
            else if (path) enter(path);
            else addTyped();
          } else if (event.key === "Backspace" && value === "") {
            onBack();
          }
        }}
      />
      {error ? (
        <p className="palette-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="palette-list">
        {listing.status === "error" ? <p className="sidebar-empty">{listing.error.message}</p> : null}
        {listing.status === "ready" && rows === 0 ? <p className="sidebar-empty">No folders here</p> : null}
        {rows > 0 ? <div className="palette-group">Directories</div> : null}
        {parent ? (
          <button
            type="button"
            data-active={active === 0 || undefined}
            onMouseMove={() => setActive(0)}
            onClick={() => enter(parent)}
          >
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
              <span className="palette-title">{entry.name}</span>
            </button>
          );
        })}
      </div>
      <Keys back select={false} />
    </>
  );
}

function SingleField({
  placeholder,
  label,
  chipLabel,
  hint,
  submit,
  onBack,
}: {
  placeholder: string;
  label: string;
  chipLabel: string;
  hint: string | null;
  submit(value: string): Promise<void>;
  onBack(): void;
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
    <>
      <Head
        value={value}
        placeholder={placeholder}
        label={label}
        chip={{ label: chipLabel, onClick: () => void send(), disabled: busy || !value.trim() }}
        onBack={onBack}
        onChange={setValue}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void send();
          } else if (event.key === "Backspace" && value === "") {
            onBack();
          }
        }}
      />
      {error ? (
        <p className="palette-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="palette-hint">{hint}</p>
      ) : null}
      <Keys back select={false} />
    </>
  );
}

/** Adding a project, as the palette's own views. Folders stay where they are. */
export function AddProjectPalette({ onBack, onClose }: { onBack(): void; onClose(): void }) {
  const [view, setView] = useState<View>("sources");
  const finish = useFinish(onClose);
  const toSources = () => setView("sources");
  switch (view) {
    case "sources":
      return <Sources onPick={setView} onBack={onBack} />;
    case "browse":
      return <Browse onBack={toSources} onClose={onClose} />;
    case "new":
      return (
        <SingleField
          placeholder="Project name"
          label="Project name"
          chipLabel="Create"
          hint={null}
          onBack={toSources}
          submit={async (name) => finish(await api.createProject(name))}
        />
      );
    case "clone":
      return (
        <SingleField
          placeholder="Enter Git clone URL"
          label="Git clone URL"
          chipLabel="Clone"
          hint="Enter a Git clone URL and press Enter to continue."
          onBack={toSources}
          submit={async (url) => {
            const job = await api.startClone(url);
            onClose();
            void followClone(job.id, finish);
          }}
        />
      );
  }
}
