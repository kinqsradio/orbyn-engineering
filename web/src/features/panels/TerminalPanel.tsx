import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTerminalShortcut } from "../../app/shortcuts";
import { readingKey } from "./terminalKeys";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, Pill } from "../../ui/controls";
import { terminalUrl } from "./terminalSocket";
import { linkProvider } from "./terminalLinks";
import { Menu } from "../../ui/Menu";
import { terminalSelection } from "../thread/terminalContext";

type Connection = "connecting" | "open" | "closed";

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const terminalTheme = () => ({
  background: cssVar("--color-raised"),
  foreground: cssVar("--color-text"),
  cursor: cssVar("--color-text"),
  selectionBackground: cssVar("--color-selected"),
});

/** Loaded on first use. xterm's default DOM renderer: WebGL is unsafe on WebKit. */
const loadXterm = async () => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return { Terminal, FitAddon };
};

export function TerminalPanel({
  threadId,
  terminalId,
  terminalLabel = "Terminal",
  observe = false,
}: {
  threadId: string;
  terminalId?: string;
  terminalLabel?: string;
  /** Shows the output and sends nothing, so it can sit beside a running script. */
  observe?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const theme = useUi((state) => state.theme);
  const applyThemeRef = useRef<() => void>(() => undefined);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const readSelection = useRef<() => ReturnType<typeof terminalSelection>>(() => null);
  const clearSelection = useRef<() => void>(() => undefined);

  useEffect(() => {
    applyThemeRef.current();
  }, [theme]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    setSelectionMenu(null);
    setConnection("connecting");

    void loadXterm().then(({ Terminal, FitAddon }) => {
      if (disposed) return;
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: false,
        fontFamily: cssVar("--font-mono"),
        fontSize: useUi.getState().typography.terminalSize,
        scrollback: 5000,
        theme: terminalTheme(),
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (isTerminalShortcut(event)) return false;
        return !readingKey(terminal, event, /mac/i.test(navigator.platform));
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      readSelection.current = () => terminalSelection(terminal.getSelection(), terminal.getSelectionPosition());
      clearSelection.current = () => terminal.clearSelection();
      let selectionTimer: ReturnType<typeof setTimeout> | undefined;
      let selectionFrame = 0;
      const dismissSelection = () => { clearTimeout(selectionTimer); cancelAnimationFrame(selectionFrame); setSelectionMenu(null); };
      const dismissOnPointer = (event: PointerEvent) => {
        if (!(event.target as Element | null)?.closest("[data-menu-root]")) dismissSelection();
      };
      const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") dismissSelection(); };
      const offerSelection = (event: MouseEvent) => {
        if (event.button !== 0 && event.type !== "contextmenu") return;
        const { clientX: x, clientY: y, detail } = event;
        if (event.type === "contextmenu" && readSelection.current()) event.preventDefault();
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => { selectionFrame = requestAnimationFrame(() => {
          const selected = readSelection.current();
          if (!disposed && selected) setSelectionMenu({ x, y, text: selected.text });
        }); }, detail >= 2 ? 500 : 0);
      };
      element.addEventListener("mouseup", offerSelection);
      element.addEventListener("contextmenu", offerSelection);
      window.addEventListener("blur", dismissSelection);
      window.addEventListener("resize", dismissSelection);
      window.addEventListener("pointerdown", dismissOnPointer);
      window.addEventListener("keydown", dismissOnEscape);
      element.addEventListener("scroll", dismissSelection, true);
      // xterm publishes the final selection asynchronously after mouseup. Hide a
      // stale menu without cancelling that gesture's pending offer.
      const selectionChange = terminal.onSelectionChange(() => setSelectionMenu(null));
      const links = terminal.registerLinkProvider(
        linkProvider(terminal, (link) => {
          if (link.kind === "url") {
            const { linkTarget, showInBrowser } = useUi.getState();
            if (linkTarget === "in-app") showInBrowser(link.url);
            else window.open(link.url, "_blank", "noopener,noreferrer");
            return;
          }
          // A workspace file always opens in the in-app preview, wherever addresses go.
          api.openPreviewFile(threadId, link.path).then(
            () => useUi.getState().showInBrowser(""),
            (failure: unknown) => useUi.getState().pushToast(`Couldn't open it. ${toFailure(failure).message}`),
          );
        }),
      );
      applyThemeRef.current = () => {
        terminal.options.theme = terminalTheme();
      };

      const socket = new WebSocket(terminalUrl(threadId, window.location, terminalId, observe));
      socket.binaryType = "arraybuffer";
      const encoder = new TextEncoder();

      let sentSize = "";
      const resize = () => {
        if (element.clientWidth === 0 || element.clientHeight === 0) return;
        fit.fit();
        const size = JSON.stringify({ cols: terminal.cols, rows: terminal.rows });
        if (socket.readyState === WebSocket.OPEN && size !== sentSize) {
          sentSize = size;
          socket.send(size);
        }
      };

      socket.onopen = () => {
        setConnection("open");
        resize();
      };
      socket.onclose = () => {
        if (!disposed) setConnection("closed");
      };
      socket.onmessage = (message: MessageEvent<ArrayBuffer | string>) => {
        terminal.write(typeof message.data === "string" ? message.data : new Uint8Array(message.data));
      };
      const input = terminal.onData((data) => {
        if (!observe && socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      });
      observer.observe(element);

      cleanup = () => {
        dismissSelection();
        selectionChange.dispose();
        element.removeEventListener("mouseup", offerSelection);
        element.removeEventListener("contextmenu", offerSelection);
        window.removeEventListener("blur", dismissSelection);
        window.removeEventListener("resize", dismissSelection);
        window.removeEventListener("pointerdown", dismissOnPointer);
        window.removeEventListener("keydown", dismissOnEscape);
        element.removeEventListener("scroll", dismissSelection, true);
        readSelection.current = () => null;
        clearSelection.current = () => undefined;
        cancelAnimationFrame(frame);
        observer.disconnect();
        input.dispose();
        links.dispose();
        socket.onclose = null;
        socket.close();
        applyThemeRef.current = () => undefined;
        terminal.dispose();
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [threadId, terminalId, attempt, observe]);

  return (
    <div className="terminal-panel">
      <div className="panel-bar">
        <Pill tone={connection === "open" ? "accent" : connection === "closed" ? "warn" : "neutral"}>
          {connection === "open" ? "Connected" : connection === "closed" ? "Disconnected" : "Connecting"}
        </Pill>
        {connection === "closed" ? (
          <Button small icon={<RotateCw size={16} aria-hidden />} onClick={() => setAttempt(attempt + 1)}>
            Reconnect
          </Button>
        ) : null}
      </div>
      <div ref={host} className="terminal-host" role="group" aria-label="Terminal" />
      {selectionMenu ? <Menu {...selectionMenu} label="Terminal selection" onClose={() => setSelectionMenu(null)} items={[
        { label: "Add to chat", onSelect: () => {
          const selected = readSelection.current();
          if (!selected || selected.text !== selectionMenu.text) return;
          const added = useUi.getState().addTerminalContext(threadId, {
            id: crypto.randomUUID(), terminalId: terminalId ?? "main", terminalLabel, ...selected,
          });
          if (!added) {
            useUi.getState().pushToast("Terminal excerpt exceeds the message limit. Select a smaller excerpt.");
            return;
          }
          clearSelection.current();
          // The terminal and the composer share the same thread surface.
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-thread-composer="${CSS.escape(threadId)}"] textarea`)?.focus());
        } },
        { label: "Copy", onSelect: () => {
          void navigator.clipboard.writeText(selectionMenu.text).catch((failure: unknown) =>
            useUi.getState().pushToast(`Couldn't copy. ${toFailure(failure).message}`));
        } },
      ]} /> : null}
    </div>
  );
}
