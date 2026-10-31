import { useEffect, type RefObject } from "react";

/**
 * Looping animations read `--loop-state` and rest paused unless it says run.
 * This keeps a region's loops running only while it's on screen in a visible tab.
 */
export function useLoopsWhileVisible(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const region = ref.current;
    if (!region) return;
    let onScreen = true;
    const publish = () => {
      region.style.setProperty("--loop-state", onScreen && !document.hidden ? "running" : "paused");
    };
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            onScreen = entry?.isIntersecting ?? onScreen;
            publish();
          })
        : null;
    observer?.observe(region);
    document.addEventListener("visibilitychange", publish);
    publish();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", publish);
    };
  }, [ref]);
}
