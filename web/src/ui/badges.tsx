import { badgeTint, monogram } from "../lib/format";

export function ProjectBadge({ name }: { name: string }) {
  return (
    <span className={`badge badge-${badgeTint(name)}`} aria-hidden>
      {monogram(name)}
    </span>
  );
}

/** A neutral letter, never a vendor's mark. */
export function EngineGlyph({ name }: { name: string }) {
  return (
    <span className="engine-glyph" title={name} aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function OrbynMark() {
  return <span className="brand-mark" aria-hidden />;
}
