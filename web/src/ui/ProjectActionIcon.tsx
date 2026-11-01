import { Bug, FlaskConical, Hammer, ListChecks, Play, Wrench } from "lucide-react";

const glyphs = { play: Play, test: FlaskConical, lint: ListChecks, configure: Wrench, build: Hammer, debug: Bug };
export const ACTION_ICONS = [
  { value: "play", label: "Play" }, { value: "test", label: "Test" },
  { value: "lint", label: "Lint" }, { value: "configure", label: "Configure" },
  { value: "build", label: "Build" }, { value: "debug", label: "Debug" },
] as const;

export function ProjectActionIcon({ icon, size = 16 }: { icon: string | null; size?: number }) {
  const Glyph = icon && Object.hasOwn(glyphs, icon) ? glyphs[icon as keyof typeof glyphs] : Play;
  return <Glyph size={size} aria-hidden />;
}
