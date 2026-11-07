/** Provider instances as the service stores them (the `provider_instances` preference) and lists them (one engine each). */
import type { JsonValue } from "../src/api/types.ts";
import type { EngineStatus } from "../src/api/types.ts";

export const providerInstances: JsonValue[] = [
  { id: "claude_personal", driver: "claude", enabled: true, name: "Personal", accent: "#3b82f6", program: "/Users/dev/.local/bin/claude", auto_compact_window: "300000" },
  { id: "claude_work", driver: "claude", enabled: true, name: "Work", accent: "#f59e0b", program: "/Users/dev/work/bin/claude" },
  { id: "gemini_acp_local", driver: "gemini-acp", enabled: true, name: "Local", accent: "#64748b", program: "/opt/homebrew/bin/gemini", args: ["--experimental-acp", "--add-dir", "~/Documents/Github"] },
];

/** Each instance is listed beside its provider, named `Provider · Name` and pointing back at it. */
export function instanceEngines(base: EngineStatus[]): EngineStatus[] {
  return providerInstances.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const parent = base.find((engine) => engine.id === entry.driver);
    if (!parent || typeof entry.id !== "string") return [];
    return [{ ...parent, id: entry.id, name: `${parent.name} · ${String(entry.name)}`, path: typeof entry.program === "string" ? entry.program : parent.path,
      instance_of: parent.id, update_command: null }];
  });
}

/** Models the person added by id; the service merges them into each provider's list. */
export const customModels: JsonValue[] = [
  { engine: "claude", id: "sonnet-5-5-1m" },
  { engine: "claude", id: "haiku-5-5-fast" },
  { engine: "claude_personal", id: "sonnet-5-5-1m" },
  { engine: "claude_personal", id: "haiku-5-5-fast" },
];
