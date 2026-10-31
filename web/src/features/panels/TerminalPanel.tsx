import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui";
import { Button, Pill } from "../../ui/controls";
import { terminalUrl } from "./terminalSocket";

type Connection = "connecting" | "open" | "closed";

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const terminalTheme = () => ({
  background: cssVar("--color-sunken"),
  foreground: cssVar("--color-text"),
  cursor: cssVar("--color-accent"),
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

export function TerminalPanel({ threadId }: { threadId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const theme = useUi((state) => state.theme);
  const applyThemeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    applyThemeRef.current();
  }, [theme]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    setConnection("connecting");

    void loadXterm().then(({ Terminal, FitAddon }) => {
      if (disposed) return;
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: false,
        fontFamily: cssVar("--font-mono"),
        fontSize: 13,
        scrollback: 5000,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      applyThemeRef.current = () => {
        terminal.options.theme = terminalTheme();
      };

      const socket = new WebSocket(terminalUrl(threadId));
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
        if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      });
      observer.observe(element);

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        input.dispose();
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
  }, [threadId, attempt]);

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
    </div>
  );
}
