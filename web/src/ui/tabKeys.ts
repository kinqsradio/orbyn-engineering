import type { KeyboardEvent } from "react";

/** Arrow keys, Home and End move between the tabs of a tab list and select the one reached. */
export function tabKeys(event: KeyboardEvent<HTMLElement>, select: (index: number) => void) {
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.findIndex((tab) => tab === document.activeElement);
  if (at < 0) return;
  const next =
    event.key === "ArrowRight" ? (at + 1) % tabs.length
    : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
    : event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
    : null;
  if (next === null) return;
  event.preventDefault();
  tabs[next]?.focus();
  select(next);
}
