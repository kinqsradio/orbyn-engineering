import { FolderCode, type LucideIcon } from "lucide-react";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { useEffect, useState } from "react";
import "./ProjectIconVisual.css";
import type { ProjectIconOverride } from "../../generated/ProjectIconOverride";

/** A received name selects a package-owned loader, never a URL or executable code. */
function NamedProjectIcon({ name, size }: { name: string; size: number }) {
  const [loaded, setLoaded] = useState<{ name: string; Icon: LucideIcon } | null>(null);
  useEffect(() => {
    let current = true;
    const load = Object.hasOwn(dynamicIconImports, name) ? dynamicIconImports[name as keyof typeof dynamicIconImports] : null;
    if (load) void load().then((module) => {
      if (current) setLoaded({ name, Icon: module.default });
    }).catch(() => { /* The known fallback remains visible when a package chunk cannot load. */ });
    return () => { current = false; };
  }, [name]);
  const Icon = loaded?.name === name ? loaded.Icon : FolderCode;
  return <Icon size={size} aria-hidden />;
}

/** Structured identity only; independent of image caches, workspace state and badges. */
export function ProjectIconVisual({ icon, size = 20, className = "" }: {
  icon: ProjectIconOverride;
  size?: number;
  className?: string;
}) {
  const colorClass = icon.kind === "emoji" ? null : `project-color-${icon.color}`;
  const classes = ["project-icon-visual", colorClass, className].filter(Boolean).join(" ");
  return <span className={classes}
    style={{ width: size, height: size, fontSize: size,
      color: icon.kind === "emoji" ? undefined : "var(--tint)",
      borderRadius: icon.kind === "monogram" ? "25%" : undefined,
      background: icon.kind === "monogram" ? "color-mix(in srgb, currentColor 14%, transparent)" : undefined }} aria-hidden>
    {icon.kind === "lucide" ? <NamedProjectIcon name={icon.name} size={size} /> : icon.kind === "emoji" ? icon.emoji : <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: "hidden", fontFamily: "var(--font-mono)" }}>
      <text x="50" y="50" dominantBaseline="central" textAnchor="middle" fill="currentColor" fontSize="52" fontWeight="700"
        textLength={[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(icon.text)].length === 1 ? 38 : 75}
        lengthAdjust="spacingAndGlyphs">{icon.text}</text>
    </svg>}
  </span>;
}
