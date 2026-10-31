import { useCallback, useEffect, useState } from "react";
import { ApiFailure, api, setUnauthorizedHandler } from "../api/client";
import { followShell } from "../api/shell";
import { SignIn } from "../features/onboarding/SignIn";
import { WorkspaceGate } from "../features/onboarding/WorkspaceSetup";
import { toFailure } from "../lib/useAsync";
import { useUi, applyTheme } from "../state/ui";
import { ErrorState, Loading } from "../ui/states";
import { onShellEvent, Shell } from "./Shell";

type Boot =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "sign-in" }
  | { state: "failed"; failure: ApiFailure };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const theme = useUi((state) => state.theme);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);

  const start = useCallback(() => {
    const abort = new AbortController();
    setBoot({ state: "loading" });
    api.info(abort.signal).then(
      () => setBoot({ state: "ready" }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const failure = toFailure(error);
        setBoot(failure.status === 401 ? { state: "sign-in" } : { state: "failed", failure });
      },
    );
    return () => abort.abort();
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setBoot({ state: "sign-in" }));
    return start();
  }, [start]);

  // Above the workspace gate: a first run still has a window for the shell to reach.
  const ready = boot.state === "ready";
  useEffect(() => (ready ? followShell(onShellEvent) : undefined), [ready]);

  switch (boot.state) {
    case "loading":
      return (
        <main className="boot">
          <Loading label="Connecting to Orbyn" rows={3} />
        </main>
      );
    case "sign-in":
      return <SignIn onSignedIn={start} />;
    case "failed":
      return (
        <main className="boot">
          <ErrorState title="Can't reach Orbyn" failure={boot.failure} onRetry={start} />
        </main>
      );
    case "ready":
      return (
        <WorkspaceGate>
          <Shell />
        </WorkspaceGate>
      );
  }
}
