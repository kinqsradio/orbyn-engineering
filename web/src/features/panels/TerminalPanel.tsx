import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTerminalShortcut } from "../../app/shortcuts";
import { readingKey } from "./terminalKeys";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useComposerChips } from "../thread/composerChipStore";
import { charactersOver, chipId, promptWithChips, terminalSelection } from "../thread/composerContext";
import { Button, Pill } from "../../ui/controls";
import { terminalUrl } from "./terminalSocket";
import { linkProvider } from "./terminalLinks";
import { ShellMarks, type Position, type ShellCommand } from "./shellMarks";
import type { Terminal as XTerm } from "@xterm/xterm";

type Connection = "connecting" | "open" | "closed";

/** The text typed after a prompt, from a mark's column up to the row output began on. */
function typedText(terminal: XTerm, fromLine: number, fromCol: number, toLine: number): string {
  const buffer = terminal.buffer.active;
  let text = "";
  for (let row = fromLine; row < toLine; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (row > fromLine && !line.isWrapped) text += "\n";
    text += line.translateToString(true, row === fromLine ? fromCol : 0);
  }
  return text;
}

/** The cursor as a row that follows scrolling. */
function cursorPosition(terminal: XTerm): Position {
  const buffer = terminal.buffer.active;
  const marker = terminal.registerMarker(0);
  return { row: marker ?? { line: buffer.baseY + buffer.cursorY }, col: buffer.cursorX };
}

/** What a selection inside one marked command's output adds to its chip. */
const commandFields = (shell: ShellCommand | null): { command?: string; exitCode?: number | null } => {
  if (!shell) return {};
  const fields: { command?: string; exitCode?: number | null } = shell.command === null ? {} : { command: shell.command };
  // Still running reads as null; a command that ended unmarked carries no code at all.
  if (shell.end === null || shell.exitCode !== null) fields.exitCode = shell.exitCode;
  return fields;
};

type Selection = NonNullable<ReturnType<typeof terminalSelection>> & ReturnType<typeof commandFields>;

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
  observe = false,
}: {
  threadId: string;
  terminalId?: string;
  /** Shows the output and sends nothing, so it can sit beside a running script. */
  observe?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
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
      const marks = new ShellMarks((fromLine, fromCol, toLine) => typedText(terminal, fromLine, fromCol, toLine));
      const oscs = [133, 633].map((ident) =>
        terminal.parser.registerOscHandler(ident, (data) => {
          marks.mark(ident, data, () => cursorPosition(terminal));
          return true;
        }),
      );
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
      const chosen = terminal.onSelectionChange(() => {
        const position = terminal.getSelectionPosition();
        const picked = terminalSelection(terminal.getSelection(), position);
        const shell = picked && position
          ? marks.commandAt(Math.min(position.start.y, position.end.y), Math.max(position.start.y, position.end.y))
          : null;
        setSelection(picked ? { ...picked, ...commandFields(shell) } : null);
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
        chosen.dispose();
        for (const osc of oscs) osc.dispose();
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
        {observe ? null : (
          <Button
            small
            tone="quiet"
            disabled={selection === null}
            onClick={() => {
              if (!selection) return;
              const chip = {
                id: chipId(),
                kind: "terminal" as const,
                title: "Terminal selection",
                output: selection.output,
                lineStart: selection.lineStart,
                lineEnd: selection.lineEnd,
                ...(selection.command === undefined ? {} : { command: selection.command }),
                ...(selection.exitCode === undefined ? {} : { exitCode: selection.exitCode }),
              };
              const chips = useComposerChips.getState().chips[threadId] ?? [];
              const draft = useUi.getState().drafts[threadId] ?? "";
              if (charactersOver(promptWithChips(draft, [...chips, chip])) > 0) {
                useUi
                  .getState()
                  .pushToast("Terminal selection exceeds the message limit. Select a smaller excerpt.");
                return;
              }
              useComposerChips.getState().add(threadId, chip);
              useUi.getState().pushToast("Selection added to your message");
            }}
          >
            Add selection
          </Button>
        )}
      </div>
      <div ref={host} className="terminal-host" role="group" aria-label="Terminal" />
    </div>
  );
}
