import { FolderPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../api/types";
import { ProjectBadge } from "../../ui/badges";

const WIDTH = 288;

/** The heading's project name opens this: search, switch, or add one on the spot. */
export function DraftProjectPicker({
  projects,
  current,
  anchor,
  onPick,
  onAdd,
  onClose,
}: {
  projects: readonly Project[];
  current: string;
  anchor: DOMRect;
  onPick(project: Project): void;
  onAdd(): void;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? projects.filter((project) => project.name.toLowerCase().includes(needle)) : [...projects];
  }, [projects, query]);
  const count = matches.length + 1;
  const choose = (index: number) => {
    const project = matches[index];
    if (!project) onAdd();
    else if (project.id === current) onClose();
    else onPick(project);
  };

  return (
    <div
      ref={root}
      className="filter-popup hero-picker"
      style={{
        left: Math.max(8, Math.min(window.innerWidth - WIDTH - 8, anchor.left + anchor.width / 2 - WIDTH / 2)),
        top: anchor.bottom + 4,
      }}
    >
      <input
        ref={input}
        aria-label="Search projects"
        placeholder="Search projects..."
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setAt((at + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(at);
          }
        }}
      />
      {matches.length === 0 ? <p className="filter-empty">No matching projects.</p> : null}
      <div role="listbox" aria-label="Projects">
        {matches.map((project, index) => (
          <div
            key={project.id}
            role="option"
            aria-selected={project.id === current}
            className="filter-item"
            data-active={index === at || undefined}
            onPointerEnter={() => setAt(index)}
            onClick={() => choose(index)}
          >
            <span className="filter-icon">
              <ProjectBadge name={project.name} project={project} />
            </span>
            <span className="filter-name">{project.name}</span>
          </div>
        ))}
        <div
          role="option"
          aria-selected={false}
          className="filter-item"
          data-active={at === matches.length || undefined}
          onPointerEnter={() => setAt(matches.length)}
          onClick={onAdd}
        >
          <span className="filter-icon">
            <FolderPlus size={16} aria-hidden />
          </span>
          <span className="filter-name">Add project</span>
        </div>
      </div>
    </div>
  );
}
