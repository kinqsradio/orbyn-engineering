import { create } from "zustand";
import { presetById, THEME_TOKENS, type ThemeColors } from "../features/settings/themes";
import { readJson, writeJson } from "../lib/storage";

export type ThemeChoice = "system" | "light" | "dark";
export type RightTab = "diff" | "files" | "activity" | "pulls";
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
  panelMaximized: boolean;
  /** The pane's width for this thread; null follows the window. */
  panelWidth: number | null;
  /** The current thread's layout is the fields above; others wait here. */
  layouts: Record<string, ThreadLayout>;
  layoutKey: string;
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
  preferredEditor: string | null;
  /** TeX in rendered Markdown, off unless asked for. */
  mathRendering: boolean;
  chatWidth: "comfortable" | "wide" | "full";
  /** Wraps long lines in code and diffs. */
  wordWrap: boolean;
  timestampFormat: "locale" | "12-hour" | "24-hour";
  sendShortcut: "enter" | "mod-enter-multiline" | "mod-enter";
  followUpBehavior: "queue" | "steer";
  diffLayout: "stacked" | "split";
  diffFilesCollapsed: boolean;
  diffIgnoreWhitespace: boolean;
  diffHideTests: boolean;
  /** A named palette over the base theme, for each scheme. */
  lightPreset: string | null;
  darkPreset: string | null;
  /** Colours the person set themselves, which win over any preset. */
  customColors: ThemeColors;
  typography: Typography;
  contrast: "normal" | "more";
  fontSmoothing: boolean;
  /** Keeps checkout and branch under the composer after the first send. */
  persistentComposerContext: boolean;
  /** Lists skills in the `/` menu as well as under `$`. */
  skillsInSlashMenu: boolean;
  /** Saved prompts by thread, newest first. */
  stashes: Record<string, StashedPrompt[]>;
  threadNotifications: boolean;
  inAppNotifications: boolean;
  confirmUnpin: boolean;
  confirmArchive: boolean;
  confirmDelete: boolean;
  /** The last choice, which new threads start from. */
  lastModel: { engine: string; model: string | null; effort: string | null } | null;
}

export interface Typography {
  uiFont: string;
  /** Interface size in px; everything scales from it. */
  uiSize: number;
  chatSize: number;
  codeFont: string;
  codeSize: number;
  terminalSize: number;
}

export interface StashedPrompt {
  id: string;
  text: string;
  at: string;
}

/** What each thread remembers of its layout. Drafts share the `draft` key until sent. */
export interface ThreadLayout {
  panelOpen: boolean | null;
  panelTab: RightTab | null;
  openSurfaces: RightTab[];
  detailsOpen: boolean;
  terminalOpen: boolean;
  panelMaximized: boolean;
  panelWidth: number | null;
}

export const DRAFT_LAYOUT = "draft";
const MAX_LAYOUTS = 200;

export type PaletteStart = "root" | "add-project" | "files" | "search";

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
  panelMaximized: false,
  panelWidth: null,
  layouts: {},
  layoutKey: DRAFT_LAYOUT,
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
  preferredEditor: null,
  mathRendering: false,
  chatWidth: "comfortable",
  wordWrap: false,
  timestampFormat: "locale",
  sendShortcut: "enter",
  followUpBehavior: "queue",
  diffLayout: "stacked",
  diffFilesCollapsed: false,
  diffIgnoreWhitespace: false,
  diffHideTests: false,
  lightPreset: null,
  darkPreset: null,
  customColors: {},
  typography: { uiFont: "", uiSize: 16, chatSize: 14, codeFont: "", codeSize: 13, terminalSize: 12 },
  contrast: "normal",
  fontSmoothing: true,
  persistentComposerContext: false,
  skillsInSlashMenu: false,
  stashes: {},
  threadNotifications: false,
  inAppNotifications: false,
  confirmUnpin: false,
  confirmArchive: false,
  confirmDelete: true,
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
  /** A file the Files surface should open next, with the line to reveal. */
  fileReveal: { path: string; line: number | null; nonce: number } | null;
  revealFile(path: string, line: number | null): void;
  /** A file the Diff surface should scroll to. */
  diffReveal: { path: string; nonce: number } | null;
  revealDiff(path: string): void;
  togglePanel(tab: ContextTab): void;
  closePanel(): void;
  setPanelOpen(open: boolean): void;
  /** Back to the launcher, keeping open surfaces. */
  showLauncher(): void;
  closeSurface(tab: RightTab): void;
  setPanelAnimationMs(ms: number): void;
  toggleDetails(): void;
  setPanelMaximized(maximized: boolean): void;
  setPanelWidth(width: number | null): void;
  /** Shows another thread's layout, restoring what it last had. */
  setLayoutKey(key: string): void;
  /** A sent draft keeps its layout as a thread, and the next draft starts fresh. */
  adoptDraftLayout(threadId: string): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  toggleGroup(group: string, fallback: boolean): void;
  setPrefs(
    prefs: Partial<Omit<Prefs, "layouts" | "layoutKey">>,
  ): void;
  setDraft(threadId: string, text: string): void;
  setLastThread(threadId: string): void;
}

const layoutDefaults: ThreadLayout = {
  panelOpen: defaults.panelOpen,
  panelTab: defaults.panelTab,
  openSurfaces: defaults.openSurfaces,
  detailsOpen: defaults.detailsOpen,
  terminalOpen: defaults.terminalOpen,
  panelMaximized: defaults.panelMaximized,
  panelWidth: defaults.panelWidth,
};

const currentLayout = (state: Prefs): ThreadLayout => ({
  panelOpen: state.panelOpen,
  panelTab: state.panelTab,
  openSurfaces: state.openSurfaces,
  detailsOpen: state.detailsOpen,
  terminalOpen: state.terminalOpen,
  panelMaximized: state.panelMaximized,
  panelWidth: state.panelWidth,
});

/** The newest layouts stay; object order is insertion order. */
function withLayout(layouts: Record<string, ThreadLayout>, key: string, layout: ThreadLayout) {
  const { [key]: _old, ...others } = layouts;
  const entries = Object.entries({ ...others, [key]: layout });
  return Object.fromEntries(entries.slice(-MAX_LAYOUTS));
}

const prefsOf = (state: Prefs): Prefs => ({
  theme: state.theme,
  panelOpen: state.panelOpen,
  panelTab: state.panelTab,
  openSurfaces: state.openSurfaces,
  panelAnimationMs: state.panelAnimationMs,
  detailsOpen: state.detailsOpen,
  terminalOpen: state.terminalOpen,
  panelMaximized: state.panelMaximized,
  panelWidth: state.panelWidth,
  layouts: state.layouts,
  layoutKey: state.layoutKey,
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
  preferredEditor: state.preferredEditor,
  mathRendering: state.mathRendering,
  chatWidth: state.chatWidth,
  wordWrap: state.wordWrap,
  timestampFormat: state.timestampFormat,
  sendShortcut: state.sendShortcut,
  followUpBehavior: state.followUpBehavior,
  diffLayout: state.diffLayout,
  diffFilesCollapsed: state.diffFilesCollapsed,
  diffIgnoreWhitespace: state.diffIgnoreWhitespace,
  diffHideTests: state.diffHideTests,
  lightPreset: state.lightPreset,
  darkPreset: state.darkPreset,
  customColors: state.customColors,
  typography: state.typography,
  contrast: state.contrast,
  fontSmoothing: state.fontSmoothing,
  persistentComposerContext: state.persistentComposerContext,
  skillsInSlashMenu: state.skillsInSlashMenu,
  stashes: state.stashes,
  threadNotifications: state.threadNotifications,
  inAppNotifications: state.inAppNotifications,
  confirmUnpin: state.confirmUnpin,
  confirmArchive: state.confirmArchive,
  confirmDelete: state.confirmDelete,
  lastModel: state.lastModel,
});

/** Saved preferences may predate a field or carry a removed value. */
function savedPrefs(): Partial<Prefs> {
  const saved = readJson<Partial<Prefs>>(PREFS_KEY) ?? {};
  const panelTab =
    saved.panelTab === "diff" || saved.panelTab === "files" || saved.panelTab === "activity" || saved.panelTab === "pulls"
      ? saved.panelTab
      : null;
  return { ...saved, panelTab, layouts: saved.layouts ?? {} };
}

export const useUi = create<UiState>((set, get) => {
  const savePrefs = () => {
    const state = get();
    const layouts = withLayout(state.layouts, state.layoutKey, currentLayout(state));
    set({ layouts });
    writeJson(PREFS_KEY, prefsOf({ ...state, layouts }));
  };
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
    diffReveal: null,
    revealDiff(path) {
      const { openSurfaces } = get();
      set({
        diffReveal: { path, nonce: Date.now() },
        panelOpen: true,
        panelTab: "diff",
        openSurfaces: openSurfaces.includes("diff") ? openSurfaces : [...openSurfaces, "diff"],
      });
    },
    fileReveal: null,
    revealFile(path, line) {
      const { openSurfaces } = get();
      set({
        fileReveal: { path, line, nonce: Date.now() },
        panelOpen: true,
        panelTab: "files",
        openSurfaces: openSurfaces.includes("files") ? openSurfaces : [...openSurfaces, "files"],
      });
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
    setPanelMaximized(maximized) {
      set({ panelMaximized: maximized });
      savePrefs();
    },
    setPanelWidth(width) {
      set({ panelWidth: width });
      savePrefs();
    },
    setLayoutKey(key) {
      const state = get();
      if (key === state.layoutKey) return;
      const layouts = withLayout(state.layouts, state.layoutKey, currentLayout(state));
      set({ layouts, layoutKey: key, ...(layouts[key] ?? layoutDefaults) });
      savePrefs();
    },
    adoptDraftLayout(threadId) {
      const state = get();
      if (state.layoutKey !== DRAFT_LAYOUT) return;
      const { [DRAFT_LAYOUT]: _draft, ...others } = state.layouts;
      set({ layouts: others, layoutKey: threadId });
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
  const scheme = resolveTheme(choice);
  const root = document.documentElement;
  root.dataset.theme = scheme;
  const { lightPreset, darkPreset, customColors, typography, contrast, fontSmoothing } = useUi.getState();
  const preset = presetById(scheme === "dark" ? darkPreset : lightPreset);
  for (const [token] of THEME_TOKENS) {
    const value = customColors[token] ?? preset?.colors[token];
    if (value) root.style.setProperty(token, value);
    else root.style.removeProperty(token);
  }
  root.dataset.contrast = contrast;
  root.dataset.smoothing = fontSmoothing ? "on" : "off";
  root.style.setProperty("zoom", typography.uiSize === 16 ? "" : String(typography.uiSize / 16));
  const set = (name: string, value: string) =>
    value ? root.style.setProperty(name, value) : root.style.removeProperty(name);
  set("--font-sans", typography.uiFont);
  set("--font-mono", typography.codeFont);
  root.style.setProperty("--chat-size", `${typography.chatSize}px`);
  root.style.setProperty("--code-size", `${typography.codeSize}px`);
}
