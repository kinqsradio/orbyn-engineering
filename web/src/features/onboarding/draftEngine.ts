import type { EngineStatus } from "../../api/types";

/** Managed engines first, then in the service's order. */
const byManaged = (engines: readonly EngineStatus[]) => [
  ...engines.filter((engine) => engine.capabilities.managed),
  ...engines.filter((engine) => !engine.capabilities.managed),
];

/**
 * The engine a new thread starts on. A pick made in this draft always stands. The
 * remembered engine stands unless it is signed out, because a first message there
 * can only fail; then a signed-in engine takes over, and any engine beats none.
 */
export function chooseDraftEngine(
  installed: readonly EngineStatus[],
  remembered: string | null,
  pickedHere: boolean,
): EngineStatus | null {
  const last = installed.find((engine) => engine.id === remembered) ?? null;
  if (last && (pickedHere || last.auth !== "logged_out")) return last;
  const ordered = byManaged(installed);
  return (
    ordered.find((engine) => engine.auth === "logged_in") ??
    ordered.find((engine) => engine.auth !== "logged_out") ??
    last ??
    ordered[0] ??
    null
  );
}
