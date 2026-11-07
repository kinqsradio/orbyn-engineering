/** Saved agent conversations and the ACP registry, shaped like the service's responses. */
import type { AcpRegistryEntry } from "../src/generated/AcpRegistryEntry.ts";
import type { HistoryScan } from "../src/generated/HistoryScan.ts";

export function historyScan(now: number): HistoryScan {
  const day = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const session = (id: string, title: string, cwd: string, days: number, project: string | null) => ({
    engine: "claude", session_id: id, title, cwd, updated_at: day(days), project_id: project, importable: project !== null, thread_id: null });
  return { truncated: false, sessions: [
    session("h1", "Fix login redirect", "/Users/dev/code/orbyn-engineering-app", 1, "p-app"),
    session("h2", "Sync conflict on rename", "/Users/dev/code/orbyn-engineering-app", 3, "p-app"),
    session("h3", "Try the calendar feed token", "/Users/dev/code/vendor-sdk", 5, null),
  ] } as HistoryScan;
}

export const acpRegistry: AcpRegistryEntry[] = [
  { id: "gemini", name: "Gemini CLI", version: "0.31.0", description: "Google", installable: ["npx"], engine: "gemini-acp" },
  { id: "goose", name: "Goose", version: "1.2.0", description: "Block", installable: ["binary"], engine: null },
  { id: "opencode", name: "OpenCode", version: "0.9.4", description: "SST", installable: ["npx"], engine: null },
];
