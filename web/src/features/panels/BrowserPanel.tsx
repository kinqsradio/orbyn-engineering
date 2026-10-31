import { ArrowLeft, ArrowRight, Circle, Crosshair, EyeOff, Hand, MoreHorizontal, Plus, RotateCw, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { request } from "../../api/client";
import { readToken } from "../../api/token";
import type { BrowserProfile, LocalServer, PickedElement, PreviewTab } from "../../api/types";
import { useCommand } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu, type MenuItem } from "../../ui/Menu";

const q = encodeURIComponent;
const VIEWPORT = { width: 1280, height: 800 };

const ENGINES: Record<string, string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
  kagi: "https://kagi.com/search?q=",
  startpage: "https://www.startpage.com/sp/search?query=",
};

/** A URL, a local address, or words for the chosen search engine. */
export function resolveAddress(input: string, engine: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
  return `${ENGINES[engine] ?? ENGINES.duckduckgo}${q(text)}`;
}

const PAGE_MIN = 100;
const PAGE_MAX = 4096;
const RESIZE_DELAY_MS = 300;
/** Pixels of change, both ways together, worth asking the browser to lay out again. */
const RESIZE_SLACK = 8;
const TAB_POLL_MS = 1000;

const RECENT_LIMIT = 50;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Sizes a page can take. `null` follows the panel. */
export const DEVICES: { id: string; label: string; size: { width: number; height: number } | null; phone: boolean }[] = [
  { id: "fit", label: "Fit panel", size: null, phone: false },
  { id: "phone", label: "Phone, 393 by 852", size: { width: 393, height: 852 }, phone: true },
  { id: "large-phone", label: "Large phone, 430 by 932", size: { width: 430, height: 932 }, phone: true },
  { id: "tablet", label: "Tablet, 820 by 1180", size: { width: 820, height: 1180 }, phone: true },
  { id: "laptop", label: "Laptop, 1280 by 800", size: { width: 1280, height: 800 }, phone: false },
  { id: "desktop", label: "Desktop, 1920 by 1080", size: { width: 1920, height: 1080 }, phone: false },
];

/** The next stop up or down from a zoom, which may sit between stops. */
export function stepZoom(zoom: number, up: boolean): number {
  const next = up ? ZOOM_STEPS.find((stop) => stop > zoom) : [...ZOOM_STEPS].reverse().find((stop) => stop < zoom);
  return next ?? zoom;
}

/** Newest first, each once. */
export function addRecent(recent: string[], url: string): string[] {
  return [url, ...recent.filter((entry) => entry !== url)].slice(0, RECENT_LIMIT);
}

/** What a picked element adds to the message. It came from the page, so it is quoted. */
export function pickedText(picked: PickedElement): string {
  const lines = [`Element \`${picked.selector}\``];
  if (picked.text) lines.push(`> ${picked.text.replace(/\n+/g, " ")}`);
  lines.push("```html", picked.html.replaceAll("```", "` ` `"), "```");
  return lines.join("\n");
}

/** The page follows the panel, within the sizes the service takes. */
export function pageSize(width: number, height: number): { width: number; height: number } {
  const fit = (value: number) => Math.min(PAGE_MAX, Math.max(PAGE_MIN, Math.round(value)));
  return { width: fit(width), height: fit(height) };
}

function frameSocket(threadId: string, tabId: string) {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = readToken();
  const query = token ? `?token=${q(token)}` : "";
  return new WebSocket(`${scheme}//${window.location.host}/ws/preview/${q(threadId)}/${q(tabId)}${query}`);
}

/** The page's frames, with input forwarded while you hold control. */
export function PageView({
  threadId,
  tab,
  fitted: follow = true,
  picking = false,
  onPicked,
}: {
  threadId: string;
  tab: PreviewTab;
  /** False leaves the page at the size it was given. */
  fitted?: boolean;
  picking?: boolean;
  onPicked?(picked: PickedElement): void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const stage = useRef<HTMLImageElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const pushToast = useUi((state) => state.pushToast);
  const human = tab.control === "human";
  useEffect(() => {
    const socket = frameSocket(threadId, tab.id);
    socket.onmessage = (event) => {
      setLost(false);
      setFrame(String(event.data));
    };
    socket.onclose = () => setLost(true);
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }, [threadId, tab.id]);
  const send = (body: { kind: string; x?: number; y?: number; delta_y?: number; text?: string }) => {
    if (!human) return;
    request("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/input`, body).catch((failure: unknown) =>
      pushToast(`Couldn't reach the page. ${toFailure(failure).message}`),
    );
  };
  const point = (event: MouseEvent) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - box.left) / box.width) * tab.width,
      y: ((event.clientY - box.top) / box.height) * tab.height,
    };
  };
  const onKey = (event: KeyboardEvent) => {
    if (!human) return;
    event.preventDefault();
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) send({ kind: "text", text: event.key });
    else send({ kind: "key", text: event.key });
  };
  const onWheel = (event: WheelEvent) => send({ kind: "scroll", ...point(event), delta_y: event.deltaY });
  const fitted = useRef({ width: tab.width, height: tab.height });
  useEffect(() => {
    const element = area.current;
    if (!element || !follow) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = pageSize(entry.contentRect.width, entry.contentRect.height);
        if (Math.abs(size.width - fitted.current.width) + Math.abs(size.height - fitted.current.height) < RESIZE_SLACK) return;
        fitted.current = size;
        request("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/resize`, size).catch((failure: unknown) =>
          pushToast(`Couldn't resize the page. ${toFailure(failure).message}`),
        );
      }, RESIZE_DELAY_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [threadId, tab.id, pushToast, follow]);
  const click = (event: MouseEvent) => {
    if (!picking) {
      send({ kind: "click", ...point(event) });
      return;
    }
    request<PickedElement>("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/pick`, point(event)).then(
      (picked) => onPicked?.(picked),
      (failure: unknown) => pushToast(`Couldn't read that element. ${toFailure(failure).message}`),
    );
  };
  return (
    <div ref={area} className="browser-stage" data-picking={picking || undefined}>
      {frame ? (
        <img
          ref={stage}
          className="browser-frame"
          data-preview
          data-human={human || undefined}
          tabIndex={0}
          alt={`Page at ${tab.url}`}
          src={`data:image/jpeg;base64,${frame}`}
          onClick={click}
          onKeyDown={onKey}
          onWheel={onWheel}
        />
      ) : (
        <p className="browser-note">{lost ? "Browser connection was refused." : "Connecting..."}</p>
      )}
      {tab.crashed ? (
        <p className="browser-note" role="alert">
          This page keeps crashing. Close the tab and open it again.
        </p>
      ) : null}
    </div>
  );
}

/** Reachable servers from this thread's processes, and pages opened before. */
function StartPage({
  threadId,
  onOpen,
  profile,
  setProfile,
  isPrivate,
}: {
  threadId: string;
  onOpen(url: string): void;
  profile: string;
  setProfile(id: string): void;
  isPrivate: boolean;
}) {
  const profiles = useAsync("browser-profiles", (signal) =>
    request<BrowserProfile[]>("GET", "/api/browser-profiles", undefined, signal),
  );
  const servers = useAsync(`servers:${threadId}`, (signal) =>
    request<LocalServer[]>("GET", `/api/threads/${q(threadId)}/servers`, undefined, signal),
  );
  const recent = useUi((state) => state.recentUrls);
  const pushToast = useUi((state) => state.pushToast);
  const list = servers.data ?? [];
  return (
    <div className="browser-start">
      <h3>No preview yet</h3>
      <p>Type a URL above, or run a dev script. Browser-ready localhost servers will show up here automatically.</p>
      {isPrivate ? <p>This tab is private: its pages stay out of your history.</p> : null}
      {profiles.data && profiles.data.length > 0 ? (
        <label className="browser-profile">
          Profile
          <select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value)}>
            <option value="">None, ends with the tab</option>
            {profiles.data.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.in_use}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {list.length > 0 ? (
        <ul aria-label="Local servers">
          {list.map((server) => (
            <li key={server.port}>
              <button type="button" onClick={() => onOpen(`http://localhost:${server.port}`)}>
                localhost:{server.port} <span>{server.process}</span>
              </button>
              {server.in_checkout ? (
                <IconButton
                  label={`Stop localhost:${server.port}`}
                  onClick={() => {
                    request<void>("POST", `/api/threads/${q(threadId)}/servers/${server.pid}/stop`).then(servers.reload, (failure: unknown) =>
                      pushToast(`Couldn't stop it. ${toFailure(failure).message}`),
                    );
                  }}
                >
                  <Square size={12} aria-hidden />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <ul aria-label="Recent pages">
          {recent.map((url) => (
            <li key={url}>
              <button type="button" onClick={() => onOpen(url)}>
                {url}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function BrowserPanel({ threadId }: { threadId: string }) {
  const base = `/api/threads/${q(threadId)}/previews`;
  const tabs = useAsync(`previews:${threadId}`, (signal) => request<PreviewTab[]>("GET", base, undefined, signal));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftTab, setDraftTab] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [profile, setProfile] = useState("");
  /** The device each tab is shown as, while the toolbar is open. */
  const [devices, setDevices] = useState<Record<string, string>>({});
  const [toolbar, setToolbar] = useState(false);
  const recent = useUi((state) => state.recentUrls);
  const waiting = useUi((state) => state.previewRequest);
  const searchEngine = useUi((state) => state.previewSearchEngine);
  const setPrefs = useUi((state) => state.setPrefs);
  const reload = tabs.reload;
  useCommand("preview.focusUrl", () => {
    document.querySelector<HTMLInputElement>("[data-preview-address]")?.focus();
  });
  const list = tabs.data ?? [];
  const active = draftTab ? null : (list.find((tab) => tab.id === activeId) ?? list[0] ?? null);

  const remember = (url: string) => {
    setPrefs({ recentUrls: addRecent(useUi.getState().recentUrls, url) });
  };
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      reload();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };
  const go = (raw: string) => {
    const url = resolveAddress(raw, searchEngine);
    setAddress(url);
    if (!(active?.private ?? isPrivate)) remember(url);
    void act(async () => {
      if (active) {
        await request("POST", `${base}/${q(active.id)}/navigate`, { url });
      } else {
        const how = { private: isPrivate, ...(profile ? { profile } : {}) };
        const made = await request<PreviewTab>("POST", base, { url, ...VIEWPORT, ...how });
        setDraftTab(false);
        setActiveId(made.id);
        setPrivate(false);
      }
    });
  };
  const view = (change: { zoom?: number; appearance?: string; mobile?: boolean }) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/view`, change));
  };
  const reloadPage = (hard: boolean) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/reload`, { hard }));
  };
  const clear = (what: { cookies?: boolean; cache?: boolean }) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/clear`, what));
  };
  const device = active ? (devices[active.id] ?? "fit") : "fit";
  const setDevice = (id: string, rotate = false) => {
    if (!active) return;
    const chosen = DEVICES.find((entry) => entry.id === id);
    setDevices((all) => ({ ...all, [active.id]: id }));
    if (!chosen?.size) {
      view({ mobile: false });
      return;
    }
    const size = rotate ? { width: active.height, height: active.width } : chosen.size;
    void act(async () => {
      await request("POST", `${base}/${q(active.id)}/resize`, size);
      await request("POST", `${base}/${q(active.id)}/view`, { mobile: chosen.phone });
    });
  };
  const openWaiting = useRef(go);
  useEffect(() => {
    openWaiting.current = go;
  });
  useEffect(() => {
    if (waiting === null) return;
    useUi.getState().showInBrowser(null);
    // An empty request only brings the panel forward, for a tab already made.
    if (waiting) openWaiting.current(waiting);
    else reload();
  }, [waiting, reload]);
  const onPicked = (picked: PickedElement) => {
    const { drafts, setDraft } = useUi.getState();
    const before = drafts[threadId] ?? "";
    setDraft(threadId, `${before ? `${before.trimEnd()}\n\n` : ""}${pickedText(picked)}\n`);
    setPicking(false);
  };
  const moreItems = (tab: PreviewTab): MenuItem[] => [
    { label: "Hard reload", onSelect: () => reloadPage(true) },
    { label: "Zoom in", disabled: stepZoom(tab.zoom, true) === tab.zoom, onSelect: () => view({ zoom: stepZoom(tab.zoom, true) }) },
    { label: "Zoom out", disabled: stepZoom(tab.zoom, false) === tab.zoom, onSelect: () => view({ zoom: stepZoom(tab.zoom, false) }) },
    { label: "Actual size", disabled: tab.zoom === 1, onSelect: () => view({ zoom: 1 }) },
    {
      label: "Appearance",
      separatorBefore: true,
      children: [
        { label: "System", selected: tab.appearance === "system", onSelect: () => view({ appearance: "system" }) },
        { label: "Light", selected: tab.appearance === "light", onSelect: () => view({ appearance: "light" }) },
        { label: "Dark", selected: tab.appearance === "dark", onSelect: () => view({ appearance: "dark" }) },
      ],
    },
    { label: toolbar ? "Hide device toolbar" : "Show device toolbar", separatorBefore: true, onSelect: () => setToolbar(!toolbar) },
    { label: "Float over chat", onSelect: () => useUi.getState().setPreviewFloat({ threadId, tabId: tab.id }) },
    { label: "Clear cookies", separatorBefore: true, destructive: true, onSelect: () => clear({ cookies: true }) },
    { label: "Clear cache", destructive: true, onSelect: () => clear({ cache: true }) },
  ];
  const step = (back: boolean) => {
    if (!active) return;
    void act(() => request("POST", `${base}/${q(active.id)}/history`, { back }));
  };
  // A link clicked in the page moves the tab with nobody telling this side.
  const watching = active !== null;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(reload, TAB_POLL_MS);
    return () => clearInterval(timer);
  }, [watching, reload]);
  const shown = active?.url ?? "";
  useCommand("preview.refresh", () => {
    if (!shown) return false;
    go(shown);
  });
  const human = active?.control === "human";

  return (
    <div className="browser-panel">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {list.map((tab) => (
          <span key={tab.id} className="surface-tab" data-selected={tab.id === active?.id || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active?.id}
              onClick={() => {
                setDraftTab(false);
                setActiveId(tab.id);
              }}
            >
              {tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"}
            </button>
            <IconButton
              label="Close tab"
              onClick={() => void act(() => request("DELETE", `${base}/${q(tab.id)}`))}
            >
              <X size={12} aria-hidden />
            </IconButton>
          </span>
        ))}
        <IconButton
          label="New tab"
          onClick={() => {
            setPrivate(false);
            setDraftTab(true);
          }}
        >
          <Plus size={14} aria-hidden />
        </IconButton>
        <IconButton
          label="New private tab"
          onClick={() => {
            setPrivate(true);
            setDraftTab(true);
          }}
        >
          <EyeOff size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="browser-bar">
        <IconButton label="Back" disabled={!active?.can_go_back} onClick={() => step(true)}>
          <ArrowLeft size={14} aria-hidden />
        </IconButton>
        <IconButton label="Forward" disabled={!active?.can_go_forward} onClick={() => step(false)}>
          <ArrowRight size={14} aria-hidden />
        </IconButton>
        <IconButton label="Reload" disabled={!active} onClick={() => go(shown)}>
          <RotateCw size={14} aria-hidden />
        </IconButton>
        <input
          key={shown}
          data-preview-address
          list="browser-history"
          aria-label="Search or enter URL"
          placeholder="Search or enter URL"
          defaultValue={shown || address}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.currentTarget.value.trim()) go(event.currentTarget.value);
          }}
        />
        <datalist id="browser-history">
          {recent.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
        {active ? (
          <>
            <IconButton label="Pick an element" pressed={picking} onClick={() => setPicking(!picking)}>
              <Crosshair size={14} aria-hidden />
            </IconButton>
            <IconButton
              label={human ? "Give control back" : "Take control"}
              pressed={human}
              onClick={() => void act(() => request("POST", `${base}/${q(active.id)}/control`, { human: !human }))}
            >
              <Hand size={14} aria-hidden />
            </IconButton>
            <IconButton
              label={active.recording ? "Stop recording" : "Record"}
              pressed={active.recording}
              onClick={() =>
                void act(() =>
                  active.recording
                    ? request("DELETE", `${base}/${q(active.id)}/recording`)
                    : request("POST", `${base}/${q(active.id)}/recording`),
                )
              }
            >
              {active.recording ? <Square size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
            </IconButton>
            <IconButton
              label="More page actions"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ x: box.right - 180, y: box.bottom + 4 });
              }}
            >
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
          </>
        ) : null}
      </div>
      {menu && active ? <Menu x={menu.x} y={menu.y} label="Page actions" items={moreItems(active)} onClose={() => setMenu(null)} /> : null}
      {toolbar && active ? (
        <div className="browser-devices" role="toolbar" aria-label="Device toolbar">
          <select aria-label="Device" value={device} onChange={(event) => setDevice(event.target.value)}>
            {DEVICES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <span>
            {active.width} by {active.height}
          </span>
          <IconButton label="Rotate" disabled={device === "fit"} onClick={() => setDevice(device, true)}>
            <RotateCw size={14} aria-hidden />
          </IconButton>
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {active ? (
        <PageView threadId={threadId} tab={active} fitted={device === "fit"} picking={picking} onPicked={onPicked} />
      ) : busy ? (
        <p className="browser-note" role="status">
          Connecting...
        </p>
      ) : (
        <StartPage threadId={threadId} onOpen={go} profile={profile} setProfile={setProfile} isPrivate={isPrivate} />
      )}
    </div>
  );
}
