import { badgeTint, monogram } from "../lib/format";

export function ProjectBadge({ name }: { name: string }) {
  return (
    <span className={`badge badge-${badgeTint(name)}`} aria-hidden>
      {monogram(name)}
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
