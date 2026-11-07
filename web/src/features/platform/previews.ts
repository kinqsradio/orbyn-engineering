import { lazy } from "react";

/**
 * Design screens for the Orbyn platform (accounts, connected apps, remote access) that
 * have no engine behind them yet. Nothing in the app links to them: they open only by
 * hash route, and only when the build-time flag `__ORBYN_PREVIEWS__` is true. The flag is
 * false in a production build, so the lazy import below is dead code and the chunk is
 * never emitted.
 */
export const PREVIEW_SCREENS = ["account", "connect-planner", "pair-phone", "phone", "phone-offline"] as const;
export type PreviewScreenName = (typeof PREVIEW_SCREENS)[number];

export function previewScreenRoute(hash: string): PreviewScreenName | null {
  if (!__ORBYN_PREVIEWS__) return null;
  const match = /^#\/preview\/([a-z-]+)$/.exec(hash);
  return PREVIEW_SCREENS.find((name) => name === match?.[1]) ?? null;
}

export const PreviewScreen = __ORBYN_PREVIEWS__ ? lazy(() => import("./PreviewScreens")) : null;
