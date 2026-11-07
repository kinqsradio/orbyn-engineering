import { create } from "zustand";

/**
 * What the app knows about reaching its own service. "Offline" is only ever this device having
 * no network; a service that does not answer is its own state and is named as such.
 */
export type ConnectionKind = "offline" | "service-down";

interface ConnectionStore {
  /** The browser says this device has no network. */
  offline: boolean;
  /** The service did not answer while the network was fine. */
  serviceDown: boolean;
  setOffline(offline: boolean): void;
  setServiceDown(down: boolean): void;
}

export const useConnection = create<ConnectionStore>((set) => ({
  offline: typeof navigator !== "undefined" && navigator.onLine === false,
  serviceDown: false,
  setOffline: (offline) => set({ offline }),
  setServiceDown: (serviceDown) => set((state) => (state.serviceDown === serviceDown ? state : { serviceDown })),
}));

/** A request or stream reached the service. */
export const markReachable = () => useConnection.getState().setServiceDown(false);

/** A request or stream failed with the network up: the service is what did not answer. */
export const markUnreachable = () => {
  const state = useConnection.getState();
  if (!state.offline) state.setServiceDown(true);
};

/** The one failure to show, offline first: with no network, nothing else can be told apart. */
export function connectionKind(state: Pick<ConnectionStore, "offline" | "serviceDown">): ConnectionKind | null {
  return state.offline ? "offline" : state.serviceDown ? "service-down" : null;
}

export const useConnectionKind = (): ConnectionKind | null => useConnection(connectionKind);

const PROBE_MS = 3000;
/** A probe that has not answered by now counts as failed, so probes never pile up. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * Follows the browser's network events, and asks the service whether it is back while it is down.
 * `probe` resolves when the service answers and should stop when its signal aborts; only one probe
 * is in flight at a time. Returns a stop function.
 */
export function watchConnection(probe: (signal: AbortSignal) => Promise<unknown>): () => void {
  const sync = () => useConnection.getState().setOffline(navigator.onLine === false);
  sync();
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let asking = false;
  const ask = () => {
    if (stopped || asking) return;
    if (!useConnection.getState().serviceDown || useConnection.getState().offline) return;
    asking = true;
    const abort = new AbortController();
    const cutoff = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    // A probe that ignores the signal is also given up on at the cutoff.
    const gaveUp = new Promise<never>((_, reject) =>
      abort.signal.addEventListener("abort", () => reject(new Error("The service did not answer.")), { once: true }),
    );
    Promise.race([probe(abort.signal), gaveUp])
      .then(markReachable, () => undefined)
      .finally(() => {
        clearTimeout(cutoff);
        asking = false;
      });
  };
  const unsubscribe = useConnection.subscribe((state) => {
    if (state.serviceDown && !state.offline && timer === undefined) timer = setInterval(ask, PROBE_MS);
    if ((!state.serviceDown || state.offline) && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== undefined) clearInterval(timer);
    window.removeEventListener("online", sync);
    window.removeEventListener("offline", sync);
  };
}
