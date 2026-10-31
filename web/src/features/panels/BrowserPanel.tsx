import { ArrowLeft, ArrowRight, Circle, Hand, Plus, RotateCw, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { request } from "../../api/client";
import { readToken } from "../../api/token";
import type { LocalServer, PreviewTab } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";

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
function PageView({ threadId, tab }: { threadId: string; tab: PreviewTab }) {
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
    if (!element) return;
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
  }, [threadId, tab.id, pushToast]);
  return (
    <div ref={area} className="browser-stage">
      {frame ? (
        <img
          ref={stage}
          className="browser-frame"
          data-preview
          data-human={human || undefined}
          tabIndex={0}
          alt={`Page at ${tab.url}`}
          src={`data:image/jpeg;base64,${frame}`}
          onClick={(event) => send({ kind: "click", ...point(event) })}
          onKeyDown={onKey}
          onWheel={onWheel}
        />
      ) : (
        <p className="browser-note">{lost ? "Browser connection was refused." : "Connecting..."}</p>
      )}
    </div>
  );
}

/** Reachable servers from this thread's processes, and pages opened before. */
function StartPage({ threadId, onOpen }: { threadId: string; onOpen(url: string): void }) {
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
  const searchEngine = useUi((state) => state.previewSearchEngine);
  const setPrefs = useUi((state) => state.setPrefs);
  const reload = tabs.reload;
  const list = tabs.data ?? [];
  const active = draftTab ? null : (list.find((tab) => tab.id === activeId) ?? list[0] ?? null);

  const remember = (url: string) => {
    const recent = useUi.getState().recentUrls;
    setPrefs({ recentUrls: [url, ...recent.filter((entry) => entry !== url)].slice(0, 8) });
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
    remember(url);
    void act(async () => {
      if (active) {
        await request("POST", `${base}/${q(active.id)}/navigate`, { url });
      } else {
        const made = await request<PreviewTab>("POST", base, { url, ...VIEWPORT });
        setDraftTab(false);
        setActiveId(made.id);
      }
    });
  };
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
              {tab.url.replace(/^https?:\/\//, "") || "New tab"}
            </button>
            <IconButton
              label="Close tab"
              onClick={() => void act(() => request("DELETE", `${base}/${q(tab.id)}`))}
            >
              <X size={12} aria-hidden />
            </IconButton>
          </span>
        ))}
        <IconButton label="New tab" onClick={() => setDraftTab(true)}>
          <Plus size={14} aria-hidden />
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
          aria-label="Search or enter URL"
          placeholder="Search or enter URL"
          defaultValue={shown || address}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.currentTarget.value.trim()) go(event.currentTarget.value);
          }}
        />
        {active ? (
          <>
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
          </>
        ) : null}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {active ? (
        <PageView threadId={threadId} tab={active} />
      ) : busy ? (
        <p className="browser-note" role="status">
          Connecting...
        </p>
      ) : (
        <StartPage threadId={threadId} onOpen={go} />
      )}
    </div>
  );
}
