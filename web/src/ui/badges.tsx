import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useWorkspace } from "../state/workspace";
import type { Project } from "../api/types";
import { projectImageKey, readProjectImage, rejectProjectImage, subscribeProjectImage } from "../lib/projectImages";
import { ProjectIconVisual } from "../features/settings/ProjectIconVisual";
import { deriveProjectIdentity } from "../lib/projectIdentity";

/** Keep the last decoded image visible while a replacement loads. */
function ProjectImageDisplay({ url, cacheKey, fallback }: { url: string; cacheKey: string; fallback: ReactNode }) {
  const [displayed, setDisplayed] = useState<string | null>(null);
  const current = useRef(url);
  useLayoutEffect(() => { current.current = url; }, [url]);
  const urls = displayed && displayed !== url ? [displayed, url] : [url];
  return <span className="project-image-display" aria-hidden>
    {!displayed ? fallback : null}
    {urls.map((source) => <span key={source} className={source === displayed ? "badge badge-image" : "badge badge-image project-image-pending"}>
      <img src={source} alt="" crossOrigin="anonymous" onLoad={() => {
        if (current.current === source) setDisplayed(source);
      }} onError={() => {
        rejectProjectImage(cacheKey, source);
        setDisplayed((previous) => previous === source ? null : previous);
      }} />
    </span>)}
  </span>;
}

export function ProjectBadge({ name, project }: { name: string; project?: Project }) {
  // Registration may arrive before workspace metadata identifies the protected
  // library. Keep automatic identity until its canonical path is known.
  const libraryPath = useWorkspace((state) => state.managed.data?.library?.path);
  const icon = project?.project_icon;
  const eligible = libraryPath && project && !icon && !project.scratch && project.path !== libraryPath ? project : undefined;
  const id = eligible?.id;
  const path = eligible?.path;
  const faviconPath = eligible?.favicon_path ?? null;
  const key = eligible ? projectImageKey(eligible) : null;
  const subscribe = useCallback((listener: () => void) => key && id && path
    ? subscribeProjectImage(key, { id, path, favicon_path: faviconPath }, listener) : () => {}, [key, id, path, faviconPath]);
  const snapshot = useCallback(() => key ? readProjectImage(key) : null, [key]);
  const image = useSyncExternalStore(subscribe, snapshot, () => null);
  const identity = useMemo(() => deriveProjectIdentity(name), [name]);
  if (icon) return <ProjectIconVisual icon={icon} />;
  const fallback = <span className={`badge project-monogram project-color-${identity.color}`} aria-hidden>
    <span>{identity.monogram}</span>
  </span>;
  return image && key ? <ProjectImageDisplay key={key} url={image} cacheKey={key} fallback={fallback} /> : fallback;
}

/** A neutral letter, never a vendor's mark. */
export function EngineGlyph({ name, letters = 1 }: { name: string; letters?: number }) {
  const mark = name.slice(0, letters);
  return (
    <span className="engine-glyph" title={name} aria-hidden>
      {mark.charAt(0).toUpperCase() + mark.slice(1)}
    </span>
  );
}

export function OrbynMark() {
  return <span className="brand-mark" aria-hidden />;
}
