import { create } from "zustand";
import { readJson, writeJson } from "../lib/storage";

export type ThemeChoice = "system" | "light" | "dark";
export type RightTab = "diff" | "activity";
export type ContextTab = RightTab | "terminal";

interface Prefs {
  theme: ThemeChoice;
  /** The surface pane. Null follows the layout: open only when there's room. */
  panelOpen: boolean | null;
  /** The surface showing; null is the launcher. */
  panelTab: RightTab | null;
  openSurfaces: RightTab[];
  /** Panel and hero motion in ms, 0 to 400. 0 is off, upstream's default. */
  panelAnimationMs: number;
  /** The floating details card on wide layouts. */
  detailsOpen: boolean;
  /** The terminal drawer under the conversation. */
  terminalOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** Sidebar groups the viewer has opened or closed. */
  groups: Record<string, boolean>;
  /** Projects the thread list is limited to; empty is all. */
  projectFilter: string[];
  /** Folders the active list by project. */
  projectFolders: boolean;
  /** Lets folder rows wrap their title. */
  multilineRows: boolean;
  threadSort: "updated_at" | "created_at";
  projectSort: "updated_at" | "created_at";
  /** `engine:model` keys. */
  modelFavorites: string[];
  modelHidden: string[];
  modelOrder: string[];
  effortDisplay: "label" | "bars";
  /** The last choice, which new threads start from. */
  lastModel: { engine: string; model: string | null; effort: string | null } | null;
}

export type PaletteStart = "root" | "add-project";

export const DEFAULT_SIDEBAR_WIDTH = 208;
const TOAST_MS = 4000;
let toastCounter = 0;

const PREFS_KEY = "orbyn.prefs.v1";
const DRAFTS_KEY = "orbyn.drafts.v1";

const defaults: Prefs = {
  theme: "dark",
  panelOpen: null,
  panelTab: null,
  openSurfaces: [],
  panelAnimationMs: 0,
  detailsOpen: true,
  terminalOpen: false,
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  groups: {},
  projectFilter: [],
  projectFolders: false,
  multilineRows: false,
  threadSort: "updated_at",
  projectSort: "updated_at",
  modelFavorites: [],
  modelHidden: [],
  modelOrder: [],
  effortDisplay: "label",
  lastModel: null,
};

interface UiState extends Prefs {
  drafts: Record<string, string>;
  palette: PaletteStart | null;
  setPalette(palette: PaletteStart | null): void;
  lastThreadId: string | null;
  toasts: { id: number; text: string }[];
  pushToast(text: string): void;
  dismissToast(id: number): void;
  setTheme(theme: ThemeChoice): void;
  /** Opens `tab`, or closes its surface if `tab` is already showing. */
  togglePanel(tab: ContextTab): void;
  closePanel(): void;
  setPanelOpen(open: boolean): void;
  /** Back to the launcher, keeping open surfaces. */
  showLauncher(): void;
  closeSurface(tab: RightTab): void;
  setPanelAnimationMs(ms: number): void;
  toggleDetails(): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  toggleGroup(group: string, fallback: boolean): void;
  setPrefs(
    prefs: Partial<
      Pick<
        Prefs,
        | "projectFilter"
        | "projectFolders"
        | "multilineRows"
        | "threadSort"
        | "projectSort"
        | "modelFavorites"
        | "modelHidden"
        | "modelOrder"
        | "effortDisplay"
        | "lastModel"
      >
    >,
  ): void;
  setDraft(threadId: string, text: string): void;
  setLastThread(threadId: string): void;
}

const prefsOf = (state: Prefs): Prefs => ({
  theme: state.theme,
  panelOpen: state.panelOpen,
  panelTab: state.panelTab,
  openSurfaces: state.openSurfaces,
  panelAnimationMs: state.panelAnimationMs,
  detailsOpen: state.detailsOpen,
  terminalOpen: state.terminalOpen,
  sidebarCollapsed: state.sidebarCollapsed,
  sidebarWidth: state.sidebarWidth,
  groups: state.groups,
  projectFilter: state.projectFilter,
  projectFolders: state.projectFolders,
  multilineRows: state.multilineRows,
  threadSort: state.threadSort,
  projectSort: state.projectSort,
  modelFavorites: state.modelFavorites,
  modelHidden: state.modelHidden,
  modelOrder: state.modelOrder,
  effortDisplay: state.effortDisplay,
  lastModel: state.lastModel,
});

/** Saved preferences may predate a field or carry a removed value. */
function savedPrefs(): Partial<Prefs> {
  const saved = readJson<Partial<Prefs>>(PREFS_KEY) ?? {};
  const panelTab = saved.panelTab === "diff" || saved.panelTab === "activity" ? saved.panelTab : null;
  return { ...saved, panelTab };
}

export const useUi = create<UiState>((set, get) => {
  const savePrefs = () => writeJson(PREFS_KEY, prefsOf(get()));
  return {
    ...defaults,
    ...savedPrefs(),
    drafts: readJson<Record<string, string>>(DRAFTS_KEY) ?? {},
    palette: null,
    setPalette(palette) {
      set({ palette });
    },
    lastThreadId: null,
    toasts: [],
    pushToast(text) {
      const id = ++toastCounter;
      set((state) => ({ toasts: [...state.toasts, { id, text }] }));
      setTimeout(() => get().dismissToast(id), TOAST_MS);
    },
    dismissToast(id) {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },
    setTheme(theme) {
      set({ theme });
      savePrefs();
    },
    togglePanel(tab) {
      if (tab === "terminal") {
        set((state) => ({ terminalOpen: !state.terminalOpen }));
      } else {
        const { panelOpen, panelTab, openSurfaces } = get();
        set(
          panelOpen === true && panelTab === tab
            ? { panelOpen: false }
            : {
                panelOpen: true,
                panelTab: tab,
                openSurfaces: openSurfaces.includes(tab) ? openSurfaces : [...openSurfaces, tab],
              },
        );
      }
      savePrefs();
    },
    closePanel() {
      set({ panelOpen: false });
      savePrefs();
    },
    setPanelOpen(open) {
      set({ panelOpen: open });
      savePrefs();
    },
    showLauncher() {
      set({ panelOpen: true, panelTab: null });
      savePrefs();
    },
    closeSurface(tab) {
      set((state) => {
        const openSurfaces = state.openSurfaces.filter((surface) => surface !== tab);
        return {
          openSurfaces,
          panelTab: state.panelTab === tab ? (openSurfaces.at(-1) ?? null) : state.panelTab,
        };
      });
      savePrefs();
    },
    setPanelAnimationMs(ms) {
      set({ panelAnimationMs: Math.min(Math.max(ms, 0), 400) });
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
    setSidebarWidth(width) {
      set({ sidebarWidth: width });
      savePrefs();
    },
    toggleGroup(group, fallback) {
      set((state) => ({ groups: { ...state.groups, [group]: !(state.groups[group] ?? fallback) } }));
      savePrefs();
    },
    setPrefs(prefs) {
      set(prefs);
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
