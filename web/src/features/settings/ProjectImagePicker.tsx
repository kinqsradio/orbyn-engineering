import { File } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { ProjectImageSearchResult } from "../../generated/ProjectImageSearchResult";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { projectImageCandidateUrl } from "../../lib/projectImages";
import { toFailure } from "../../lib/useAsync";
import "./ProjectImagePicker.css";

export interface ProjectImagePickerScope {
  scope: ProjectScopesQuery;
  membership_version: string;
  project_id: string;
  project_path: string;
}

/** Acquires only a fixed image capability when this candidate first enters view. */
function CandidateThumbnail({ projectId, path }: { projectId: string; path: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);
  return <span className="project-image-thumbnail" ref={element} aria-hidden>
    {!loaded ? <File size={20} aria-hidden /> : null}
    {visible && !failed ? <img src={projectImageCandidateUrl(projectId, path)} alt="" crossOrigin="anonymous" decoding="async" loading="lazy"
      style={{ visibility: loaded ? "visible" : "hidden" }} onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false); }} /> : null}
  </span>;
}

type Observation = { generation: number; query: string; result: ProjectImageSearchResult | null; error: string | null };

/** One open owns its selection snapshot; neither a later query nor scope can reuse it. */
export function ProjectImagePicker({ input, projectName, onClose, onSelect }: {
  input: ProjectImagePickerScope;
  projectName: string;
  onClose(): void;
  onSelect(path: string): void;
}) {
  const popup = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useId();
  const [searchQuery, setSearchQuery] = useState({ value: "", generation: 0 });
  const query = searchQuery.value;
  const latestQuery = useRef("");
  const generation = useRef(0);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const selected = useRef(false);
  useLayoutEffect(() => {
    const dialog = popup.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal(); search.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      const available = opener?.isConnected && opener.offsetParent !== null && !(opener instanceof HTMLButtonElement && opener.disabled);
      (available ? opener : document.querySelector<HTMLElement>("[data-page-title]"))?.focus();
    };
  }, []);
  useLayoutEffect(() => {
    let current = true;
    const abort = new AbortController();
    const requestGeneration = searchQuery.generation;
    void api.searchProjectImages({ scope: input.scope, membership_version: input.membership_version, query }, abort.signal).then((result) => {
      if (!current || latestQuery.current !== query || generation.current !== requestGeneration) return;
      if (result.project_id !== input.project_id || result.project_path !== input.project_path || result.membership_version !== input.membership_version) {
        setObservation({ generation: requestGeneration, query, result: null, error: "This project is no longer available." });
      } else setObservation({ generation: requestGeneration, query, result, error: null });
    }).catch((error: unknown) => {
      if (current && latestQuery.current === query && generation.current === requestGeneration) setObservation({ generation: requestGeneration, query, result: null, error: toFailure(error).message });
    });
    return () => { current = false; abort.abort(); };
  }, [input, query, searchQuery.generation]);
  const current = observation?.query === query && observation.generation === searchQuery.generation ? observation : null;
  const entries = current?.result?.entries.slice(0, 200) ?? [];
  const active = Math.min(cursor.query === query ? cursor.index : 0, Math.max(entries.length - 1, 0));
  const pick = (path: string) => {
    if (selected.current) return;
    selected.current = true;
    onSelect(path);
  };
  useLayoutEffect(() => {
    document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [list, active, current]);
  const empty = current?.error ?? (!current ? query.trim() ? "Searching project files…" : "Indexing project files…"
    : query.trim() ? "No matching image files." : "No image files found.");
  return <dialog ref={popup} className="project-image-dialog" aria-label="Choose project icon"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        event.preventDefault(); onClose();
      }
    }}>
    <div className="project-image-picker">
      <input ref={search} type="text" role="combobox" aria-label="Search image files" aria-expanded="true" aria-controls={list}
        aria-autocomplete="list" aria-activedescendant={entries.length ? `${list}-${active}` : undefined} placeholder="Search image files…" value={query}
        onChange={(event) => { generation.current += 1; latestQuery.current = event.target.value; setSearchQuery({ value: event.target.value, generation: generation.current }); setCursor({ query: event.target.value, index: 0 }); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (entries.length) setCursor({ query, index: (active + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length });
          } else if (event.key === "Enter" && !event.repeat && entries[active]) { event.preventDefault(); pick(entries[active].path); }
        }} />
      <div className="project-image-results" id={list} role="listbox" aria-label="Project image files" aria-busy={!current}>
        {entries.length ? <div role="group" aria-label={projectName}>
          <div className="project-image-group">{projectName}</div>
          {entries.map((entry, index) => <button type="button" role="option" key={entry.path} id={`${list}-${index}`} aria-selected={active === index} tabIndex={-1}
            className="project-image-option" onMouseMove={() => { if (active !== index) setCursor({ query, index }); }} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(entry.path)}>
            <CandidateThumbnail projectId={input.project_id} path={entry.path} />
            <span className="project-image-entry"><span>{entry.name}</span><span>{entry.path}</span></span>
          </button>)}
        </div> : <p className="project-image-empty" role={current?.error ? "alert" : "status"}>{empty}</p>}
      </div>
      <footer className="project-image-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select icon</span><span><kbd>Esc</kbd> Close</span></footer>
    </div>
  </dialog>;
}
