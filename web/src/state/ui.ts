import { create } from "zustand";
import { readJson, writeJson } from "../lib/storage";

export type ThemeChoice = "system" | "light" | "dark";
export type ContextTab = "diff" | "terminal" | "activity";

interface Prefs {
  theme: ThemeChoice;
  panelOpen: boolean;
  panelTab: ContextTab;
  collapsed: Record<string, boolean>;
}

const PREFS_KEY = "orbyn.prefs.v1";
const DRAFTS_KEY = "orbyn.drafts.v1";

const defaults: Prefs = { theme: "system", panelOpen: false, panelTab: "diff", collapsed: {} };

interface UiState extends Prefs {
  drafts: Record<string, string>;
  lastThreadId: string | null;
  setTheme(theme: ThemeChoice): void;
  /** Opens `tab`, or closes the panel if `tab` is already showing. */
  togglePanel(tab: ContextTab): void;
  closePanel(): void;
  toggleProject(projectId: string): void;
  setDraft(threadId: string, text: string): void;
  setLastThread(threadId: string): void;
}

const prefsOf = ({ theme, panelOpen, panelTab, collapsed }: Prefs): Prefs => ({
  theme,
  panelOpen,
  panelTab,
  collapsed,
});

export const useUi = create<UiState>((set, get) => {
  const savePrefs = () => writeJson(PREFS_KEY, prefsOf(get()));
  return {
    ...defaults,
    ...(readJson<Partial<Prefs>>(PREFS_KEY) ?? {}),
    drafts: readJson<Record<string, string>>(DRAFTS_KEY) ?? {},
    lastThreadId: null,
    setTheme(theme) {
      set({ theme });
      savePrefs();
    },
    togglePanel(tab) {
      const { panelOpen, panelTab } = get();
      set(panelOpen && panelTab === tab ? { panelOpen: false } : { panelOpen: true, panelTab: tab });
      savePrefs();
    },
    closePanel() {
      set({ panelOpen: false });
      savePrefs();
    },
    toggleProject(projectId) {
      set((state) => ({
        collapsed: { ...state.collapsed, [projectId]: !state.collapsed[projectId] },
      }));
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
