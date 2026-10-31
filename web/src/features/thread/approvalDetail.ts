import type { JsonValue } from "../../api/types";

export interface Touch {
  label: string;
  values: string[];
  mono: boolean;
}

const FIELDS: { keys: string[]; label: string }[] = [
  { keys: ["command", "cmd"], label: "Command" },
  { keys: ["paths", "files", "path", "file"], label: "Files" },
  { keys: ["url", "host", "domain"], label: "Address" },
  { keys: ["target"], label: "Target" },
  { keys: ["cwd"], label: "Folder" },
];

const strings = (value: JsonValue | undefined): string[] => {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  return [];
};

/** Picks what an approval will touch out of its free-form `detail`. */
export function touchesOf(detail: JsonValue): Touch[] {
  if (typeof detail === "string") {
    return detail ? [{ label: "Target", values: [detail], mono: true }] : [];
  }
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return [];
  const touches: Touch[] = [];
  for (const { keys, label } of FIELDS) {
    const values = keys.flatMap((key) => strings(detail[key]));
    if (values.length > 0) touches.push({ label, values, mono: true });
  }
  return touches;
}
