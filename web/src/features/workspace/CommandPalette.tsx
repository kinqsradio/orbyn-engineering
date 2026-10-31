import { FolderPlus, MessageSquare, Search, Settings, SquarePen } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { compactAge } from "../../lib/format";
import { navigate, SETTINGS_SECTIONS, type Route } from "../../state/route";
import type { PaletteStart } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { ProjectBadge } from "../../ui/badges";
import { AddProjectPalette } from "./AddProjectPalette";

interface Entry {
  key: string;
  group: string;
  label: string;
  meta?: string;
  icon: ReactNode;
  route: Route | "add-project" | "new-in";
}

const title = (section: string) =>
  section.charAt(0).toUpperCase() + section.slice(1);

export function CommandPalette({ start, onClose }: { start: PaletteStart; onClose(): void }) {
  const threads = useWorkspace((state) => state.threads);
  const [adding, setAdding] = useState(start === "add-project");
  const ref = useRef<HTMLDialogElement>(null);
  const [newIn, setNewIn] = useState(false);
  const projects = useVisibleProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const actions: Entry[] = [
      { key: "new", group: "Actions", label: "New thread", icon: <SquarePen size={16} aria-hidden />, route: { name: "new", projectId: null } },
      { key: "new-in", group: "Actions", label: "New thread in...", icon: <SquarePen size={16} aria-hidden />, route: "new-in" },
      { key: "add", group: "Actions", label: "Add project", icon: <FolderPlus size={16} aria-hidden />, route: "add-project" },
      ...SETTINGS_SECTIONS.map((section) => ({
        key: `settings:${section}`,
        group: "Settings",
        label: title(section),
        icon: <Settings size={16} aria-hidden />,
        route: { name: "settings", section } as Route,
      })),
    ];
    const recent = Object.values(threads)
      .filter((thread) => !thread.lifecycle?.archived_at)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((thread) => ({
        key: thread.id,
        group: "Threads",
        label: thread.title,
        meta: compactAge(thread.updated_at),
        icon: <MessageSquare size={16} aria-hidden />,
        route: { name: "thread", id: thread.id } as Route,
      }));
    const needle = query.trim().toLowerCase();
    const inProjects: Entry[] = (projects ?? []).map((project) => ({
      key: `in:${project.id}`,
      group: "Projects",
      label: project.name,
      icon: <ProjectBadge name={project.name} />,
      route: { name: "new", projectId: project.id },
    }));
    const all = newIn ? inProjects : [...actions, ...recent];
    return (needle ? all.filter((entry) => entry.label.toLowerCase().includes(needle)) : all).slice(0, 50);
  }, [threads, query, newIn, projects]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    if (entry.route === "add-project") {
      setAdding(true);
      return;
    }
    if (entry.route === "new-in") {
      setNewIn(true);
      setQuery("");
      setActive(0);
      return;
    }
    onClose();
    navigate(entry.route);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + entries.length) % Math.max(entries.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(entries[Math.min(active, entries.length - 1)]);
    }
  };

  let group = "";
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {adding ? (
        <AddProjectPalette onBack={() => (start === "add-project" ? onClose() : setAdding(false))} onClose={onClose} />
      ) : (
        <>
      <div className="palette-search">
        <Search size={16} aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-label="Search"
          placeholder="Search threads and commands"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && newIn && query === "") setNewIn(false);
            onKeyDown(event);
          }}
        />
      </div>
      <div id="palette-list" className="palette-list">
        {entries.length === 0 ? <p className="sidebar-empty">No results</p> : null}
        {entries.map((entry, at) => {
          const heading = entry.group !== group ? entry.group : null;
          group = entry.group;
          return (
            <div key={entry.key}>
              {heading ? <div className="palette-group">{heading}</div> : null}
              <button
                type="button"
                data-active={at === Math.min(active, entries.length - 1) || undefined}
                onMouseMove={() => setActive(at)}
                onClick={() => choose(entry)}
              >
                {entry.icon}
                <span className="palette-title">{entry.label}</span>
                {entry.meta ? <span>{entry.meta}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      <footer className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>Enter</kbd> Select
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </footer>
        </>
      )}
    </dialog>
  );
}
