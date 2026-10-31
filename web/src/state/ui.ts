import { create } from "zustand";
import { readJson, writeJson } from "../lib/storage";

export type ThemeChoice = "system" | "light" | "dark";
export type RightTab = "diff" | "activity";
export type ContextTab = RightTab | "terminal";

interface Prefs {
  theme: ThemeChoice;
  /** The right panel with Diff and Activity. */
  panelOpen: boolean;
  panelTab: RightTab;
  /** The floating details card on wide layouts. */
  detailsOpen: boolean;
  /** The terminal drawer under the conversation. */
  terminalOpen: boolean;
  sidebarCollapsed: boolean;
  /** Sidebar groups the viewer has opened or closed. */
  groups: Record<string, boolean>;
}

const PREFS_KEY = "orbyn.prefs.v1";
const DRAFTS_KEY = "orbyn.drafts.v1";

const defaults: Prefs = {
  theme: "dark",
  panelOpen: false,
  panelTab: "diff",
  detailsOpen: true,
  terminalOpen: false,
  sidebarCollapsed: false,
  groups: {},
};

interface UiState extends Prefs {
  drafts: Record<string, string>;
  lastThreadId: string | null;
  setTheme(theme: ThemeChoice): void;
  /** Opens `tab`, or closes its surface if `tab` is already showing. */
  togglePanel(tab: ContextTab): void;
  closePanel(): void;
  toggleDetails(): void;
  toggleSidebar(): void;
  toggleGroup(group: string, fallback: boolean): void;
  setDraft(threadId: string, text: string): void;
  setLastThread(threadId: string): void;
}

const prefsOf = (state: Prefs): Prefs => ({
  theme: state.theme,
  panelOpen: state.panelOpen,
  panelTab: state.panelTab,
  detailsOpen: state.detailsOpen,
  terminalOpen: state.terminalOpen,
  sidebarCollapsed: state.sidebarCollapsed,
  groups: state.groups,
});

/** Saved preferences may predate a field or carry a removed value. */
function savedPrefs(): Partial<Prefs> {
  const saved = readJson<Partial<Prefs>>(PREFS_KEY) ?? {};
  const panelTab = saved.panelTab === "activity" ? "activity" : "diff";
  return { ...saved, panelTab };
}

export const useUi = create<UiState>((set, get) => {
  const savePrefs = () => writeJson(PREFS_KEY, prefsOf(get()));
  return {
    ...defaults,
    ...savedPrefs(),
    drafts: readJson<Record<string, string>>(DRAFTS_KEY) ?? {},
    lastThreadId: null,
    setTheme(theme) {
      set({ theme });
      savePrefs();
    },
    togglePanel(tab) {
      if (tab === "terminal") {
        set((state) => ({ terminalOpen: !state.terminalOpen }));
      } else {
        const { panelOpen, panelTab } = get();
        set(panelOpen && panelTab === tab ? { panelOpen: false } : { panelOpen: true, panelTab: tab });
      }
      savePrefs();
    },
    closePanel() {
      set({ panelOpen: false });
      savePrefs();
    },
    toggleDetails() {
      set((state) => ({ detailsOpen: !state.detailsOpen }));
      savePrefs();
    },
    toggleSidebar() {
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      savePrefs();
    },
    toggleGroup(group, fallback) {
      set((state) => ({ groups: { ...state.groups, [group]: !(state.groups[group] ?? fallback) } }));
      savePrefs();
    },
    setDraft(threadId, text) {
      set((state) => {
        const drafts = { ...state.drafts };
        if (text) drafts[threadId] = text;
        else delete drafts[threadId];
        return { drafts };
      });
      writeJson(DRAFTS_KEY, get().drafts);
    },
    setLastThread(threadId) {
      set({ lastThreadId: threadId });
    },
  };
});

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
}
