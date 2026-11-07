import type { JsonValue } from "../../api/types";
import type { ProviderInstance } from "../../generated/ProviderInstance";
export function readInstance(value: JsonValue): ProviderInstance | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || typeof value.driver !== "string") return null;
  return { id: value.id, driver: value.driver, enabled: value.enabled !== false,
    ...(typeof value.name === "string" ? { name: value.name } : {}), ...(typeof value.accent === "string" ? { accent: value.accent } : {}),
    ...(typeof value.program === "string" ? { program: value.program } : {}),
    ...(typeof value.auto_compact_window === "string" ? { auto_compact_window: value.auto_compact_window } : {}),
    ...(Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? { args: value.args as string[] } : {}) };
}
/** Touch one existing record's fields, preserving peer and forward fields verbatim. */
export function patchInstance(all: JsonValue[], id: string, fields: Record<string, JsonValue | undefined>): JsonValue[] {
  if (all.filter((value) => readInstance(value)?.id === id).length !== 1) throw new Error("Provider instance changed. Reload before saving.");
  return all.map((value) => {
    if (readInstance(value)?.id !== id || !value || typeof value !== "object" || Array.isArray(value)) return value;
    const next = { ...value };
    for (const [key, field] of Object.entries(fields)) { if (field === undefined) delete next[key]; else next[key] = field; }
    return next;
  });
}
export function newInstanceId(driver: string, label: string, ids: ReadonlySet<string>): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  const base = `${driver}_${slug || "work"}`.slice(0, 64);
  let result = base;
  for (let suffix = 2; ids.has(result); suffix += 1) result = `${base.slice(0, 58)}_${suffix}`;
  return result;
}
export const validInstanceId = (id: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);
export const accentColor = (value: string) => /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;
/** Six digits from 100000, or exactly 1000000; empty uses Claude's default. */
export const validCompactWindow = (value: string) => value === "" || value === "1000000" || /^[1-9]\d{5}$/.test(value);
/** The six colours the instance editor offers. */
export const INSTANCE_COLORS = ["#ef4444", "#f59e0b", "#16a34a", "#3b82f6", "#a855f7", "#64748b"] as const;
/** Arguments as one line: an argument with spaces or quotes is written in double quotes. */
export const formatArgs = (args: readonly string[]) => args.map((arg) => (arg === "" || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
/** The reverse of formatArgs: whitespace separates arguments, double quotes keep one together. */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    if (match[2] !== undefined) { out.push(match[2]); continue; }
    try { out.push(JSON.parse(`"${match[1]}"`) as string); } catch { out.push(match[1] ?? ""); }
  }
  return out;
}
