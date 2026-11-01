import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useWorkspace } from "../state/workspace";
import type { Project } from "../api/types";
import { projectImageKey, readProjectImage, rejectProjectImage, subscribeProjectImage } from "../lib/projectImages";
import { ProjectIconVisual } from "../features/settings/ProjectIconVisual";
import { deriveProjectIdentity } from "../lib/projectIdentity";

export function ProjectBadge({ name, project }: { name: string; project?: Project }) {
  // Registration may arrive before workspace metadata identifies the protected
  // library. Keep automatic identity until its canonical path is known.
  const libraryPath = useWorkspace((state) => state.managed.data?.library?.path);
  const icon = project?.project_icon;
  const eligible = libraryPath && project && !icon && !project.scratch && project.path !== libraryPath ? project : undefined;
  const id = eligible?.id;
  const path = eligible?.path;
  const key = eligible ? projectImageKey(eligible) : null;
  const subscribe = useCallback((listener: () => void) => key && id && path
    ? subscribeProjectImage(key, { id, path }, listener) : () => {}, [key, id, path]);
  const snapshot = useCallback(() => key ? readProjectImage(key) : null, [key]);
  const image = useSyncExternalStore(subscribe, snapshot, () => null);
  const identity = useMemo(() => deriveProjectIdentity(name), [name]);
  if (icon) return <ProjectIconVisual icon={icon} />;
  if (image && key) return <span className="badge badge-image" aria-hidden>
    <img src={image} alt="" onError={() => rejectProjectImage(key, image)} />
  </span>;
  return (
    <span className={`badge project-monogram project-color-${identity.color}`} aria-hidden>
      <span>{identity.monogram}</span>
    </span>
  );
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
