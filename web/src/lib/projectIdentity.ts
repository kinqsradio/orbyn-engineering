/** Ordered project palette; indices are part of the automatic name identity. */
export const PROJECT_ICON_COLORS = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;

export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number];
export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function automaticMonogram(name: string): string {
  let first = "";
  let firstWordLast = "";
  let firstWordNumber = "";
  let lastWordStart = "";
  let wordCount = 0;
  let inWord = false;
  for (const point of name) {
    if (!/[\p{L}\p{N}]/u.test(point)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      wordCount += 1;
      lastWordStart = point;
      inWord = true;
    }
    if (wordCount !== 1) continue;
    if (!first) first = point;
    else if (!firstWordNumber && /\p{N}/u.test(point)) firstWordNumber = point;
    firstWordLast = point;
  }
  if (!first) return "PR";
  const second = firstWordNumber || (wordCount > 1 ? lastWordStart : firstWordLast);
  // Automatic identities use code points, including after uppercase expansion.
  // This deliberately differs from the saved monogram's grapheme validation.
  return [...(first + second).toUpperCase()].slice(0, 2).join("");
}

/** A display name alone determines identity; registration IDs and paths do not. */
export function deriveProjectIdentity(name: string): ProjectIdentity {
  const normalized = name.normalize("NFKC").trim();
  const seed = normalized.toLocaleLowerCase("en-US") || "project";
  let colorIndex = 0;
  for (const point of seed) colorIndex = (31 * colorIndex + point.codePointAt(0)!) % PROJECT_ICON_COLORS.length;
  return {
    monogram: automaticMonogram(normalized),
    color: PROJECT_ICON_COLORS[colorIndex]!,
  };
}
