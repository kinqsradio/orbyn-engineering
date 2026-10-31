import { useEffect, type RefObject } from "react";

/**
 * Stepped animations read `--visible-animation-state`, paused unless set, so a
 * status dot off screen or in a hidden tab costs no frames. Follows upstream's
 * lib/visibleAnimation.ts (see web/NOTICE).
 */
export function useVisibleAnimations(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = typeof IntersectionObserver === "undefined";
    const apply = () => {
      const running = intersecting && !document.hidden;
      element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
      element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto");
    };
    apply();
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            intersecting = entries.at(-1)?.isIntersecting ?? intersecting;
            apply();
          });
    observer?.observe(element);
    document.addEventListener("visibilitychange", apply);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, [ref]);
}
