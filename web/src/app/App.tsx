import { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiFailure, api, setUnauthorizedHandler } from "../api/client";
import { followShell, readShellStatus } from "../api/shell";
import { SignIn } from "../features/onboarding/SignIn";
import { adoptEnvironmentTheme } from "./environmentTheme";
import { toFailure } from "../lib/useAsync";
import { useUi, applyTheme } from "../state/ui";
import { ErrorState, Loading } from "../ui/states";
import { onShellEvent, Shell } from "./Shell";
import { useConnection, watchConnection } from "../state/connection";
import { upgradeToast } from "../state/healthToasts";
import { PreviewWindow } from "../features/panels/PreviewWindow";
import { previewWindowRoute } from "../features/panels/browserPanels";
import { PreviewScreen, previewScreenRoute } from "../features/platform/previews";

type Boot =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "sign-in" }
  | { state: "failed"; failure: ApiFailure };

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};
const readHash = () => window.location.hash;

/** A platform design screen (dev builds only) skips the boot and makes no request. */
export function App() {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const screen = previewScreenRoute(hash);
  if (screen && PreviewScreen) {
    return (
      <Suspense fallback={null}>
        <PreviewScreen name={screen} />
      </Suspense>
    );
  }
  return <BootedApp />;
}

function BootedApp() {
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
      (info) => {
        adoptEnvironmentTheme(info.environment_theme);
        useConnection.setState({ remote: info.remote });
        const upgraded = upgradeToast(info);
        if (upgraded) useUi.getState().pushToast(upgraded);
        setBoot({ state: "ready" });
      },
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

  const ready = boot.state === "ready";
  useEffect(() => {
    if (!ready) return;
    // A theme set from the command line reaches an open window when it next takes focus.
    const recheck = () => void api.info().then((info) => adoptEnvironmentTheme(info.environment_theme), () => undefined);
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    return watchConnection((signal) => api.info(signal));
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    void readShellStatus().catch(() => undefined);
    const preview = previewWindowRoute(window.location.hash);
    return followShell((event) => {
      if (!preview) onShellEvent(event);
      else if (event.type === "failed") useUi.getState().pushToast(event.message);
    });
  }, [ready]);

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
    case "ready": {
      const preview = previewWindowRoute(window.location.hash);
      return preview ? <PreviewWindow {...preview} /> : <Shell />;
    }
  }
}
