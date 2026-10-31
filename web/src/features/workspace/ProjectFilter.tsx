import { Check, Folder, ListFilter, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../api/types";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { ProjectBadge } from "../../ui/badges";

/** Limits the thread list to one or several projects. Shift adds or removes one. */
export function ProjectFilter({ projects }: { projects: readonly Project[] }) {
  const filter = useUi((state) => state.projectFilter);
  const setPrefs = useUi((state) => state.setPrefs);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const scoped = projects.filter((project) => filter.includes(project.id));
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? projects.filter((project) => project.name.toLowerCase().includes(needle)) : projects;
  }, [projects, query]);
  const items: (Project | null)[] = query.trim() ? [...matches] : [null, ...matches];

  const toggle = (id: string) =>
    setPrefs({
      projectFilter: filter.includes(id) ? filter.filter((entry) => entry !== id) : [...filter, id],
    });
  const pick = (project: Project | null, additive: boolean) => {
    if (!project) {
      setPrefs({ projectFilter: [] });
    } else if (additive) {
      toggle(project.id);
      return;
    } else {
      setPrefs({ projectFilter: [project.id] });
    }
    setOpen(false);
  };
  const projectSettings = () => {
    setOpen(false);
    navigate({ name: "settings", section: "projects" });
  };

  const label =
    scoped.length > 0
      ? `Filter threads by project: ${scoped.map((project) => project.name).join(", ")}`
      : "Filter threads by project";

  return (
    <div className="project-filter" ref={root}>
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setAt(0);
        }}
      >
        {scoped.length > 1 ? (
          <span className="filter-stack">
            {scoped.slice(0, 2).map((project) => (
              <ProjectBadge key={project.id} name={project.name} />
            ))}
          </span>
        ) : scoped[0] ? (
          <ProjectBadge name={scoped[0].name} />
        ) : (
          <ListFilter size={16} aria-hidden />
        )}
      </button>
      {open ? (
        <div className="filter-popup">
          <input
            autoFocus
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
                setOpen(false);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setAt((current) => Math.min(items.length - 1, Math.max(0, current + step)));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = items[at];
                if (item !== undefined) pick(item, event.shiftKey);
              } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                event.preventDefault();
                if (items[at]) projectSettings();
              }
            }}
          />
          {items.length === 0 ? <p className="filter-empty">No matching projects.</p> : null}
          <div role="listbox" aria-multiselectable aria-label="Projects">
            {items.map((project, index) => {
              const selected = project ? filter.includes(project.id) : filter.length === 0;
              return (
                <div
                  key={project?.id ?? "all"}
                  role="option"
                  aria-selected={selected}
                  className="filter-item"
                  data-active={index === at || undefined}
                  onPointerEnter={() => setAt(index)}
                  onClick={(event) => pick(project, event.shiftKey)}
                  onContextMenu={(event) => {
                    if (!project) return;
                    event.preventDefault();
                    projectSettings();
                  }}
                >
                  <span className="filter-icon">
                    {selected ? (
                      <Check size={14} aria-hidden />
                    ) : project ? (
                      <ProjectBadge name={project.name} />
                    ) : (
                      <Folder size={16} aria-hidden />
                    )}
                  </span>
                  <span className="filter-name">{project?.name ?? "All projects"}</span>
                  {project ? (
                    <button
                      type="button"
                      className="row-action"
                      tabIndex={-1}
                      aria-hidden
                      title={`Project settings for ${project.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        projectSettings();
                      }}
                    >
                      <Settings size={14} aria-hidden />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
