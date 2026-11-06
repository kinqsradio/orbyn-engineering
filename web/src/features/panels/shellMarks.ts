/**
 * Shell-integration marks in terminal output: OSC 133 (FinalTerm) and OSC 633
 * (VS Code). A shell that emits them says where each command starts, where its
 * output starts and how it exited. Orbyn installs no integration into a shell;
 * a shell that emits none simply yields no commands here.
 */

/** A buffer row that follows scrolling, as an xterm marker does. */
export interface Row {
  readonly line: number;
  readonly isDisposed?: boolean;
}

export interface Position {
  row: Row;
  col: number;
}

export interface ShellCommand {
  /** The command line, from an explicit 633;E mark or the text typed after the prompt. */
  command: string | null;
  outputStart: Row;
  /** Where the finish mark landed; null while the command still runs. */
  end: Position | null;
  /** Null while running, or when the shell reported no code. */
  exitCode: number | null;
}

/** Reads the typed text from a column of one row up to, not including, another row. */
export type ReadText = (fromLine: number, fromCol: number, toLine: number) => string;

const KEPT = 500;

/** 633;E escapes `;` and other bytes as `\xHH`, and a backslash as `\\`. */
export function decodeCommandLine(raw: string): string {
  return raw.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escaped: string, hex?: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : escaped,
  );
}

const exitOf = (value: string | undefined): number | null =>
  value !== undefined && /^-?\d+$/.test(value) ? Number(value) : null;

export class ShellMarks {
  private commands: ShellCommand[] = [];
  private commandStart: Position | null = null;
  private commandLine: string | null = null;

  constructor(private readonly read: ReadText) {}

  /**
   * One OSC 133 or 633 sequence. `at` is called only for marks that need the
   * cursor, so a caller that creates markers makes none for the rest.
   */
  mark(ident: number, data: string, at: () => Position): void {
    if (ident !== 133 && ident !== 633) return;
    const [kind, ...rest] = data.split(";");
    switch (kind) {
      case "A":
        this.closeRunning(at);
        this.commandStart = null;
        this.commandLine = null;
        return;
      case "B":
        this.commandStart = at();
        return;
      case "E":
        // Only 633 carries the command line; its optional nonce follows the line.
        if (ident === 633) this.commandLine = decodeCommandLine(rest[0] ?? "");
        return;
      case "C": {
        const here = at();
        this.closeRunning(() => here);
        const start = this.commandStart;
        const typed =
          this.commandLine ??
          (start && !start.row.isDisposed && start.row.line < here.row.line
            ? this.read(start.row.line, start.col, here.row.line)
            : null);
        const command = typed?.trim() ? typed.trim() : null;
        this.commands.push({ command, outputStart: here.row, end: null, exitCode: null });
        if (this.commands.length > KEPT) this.commands.splice(0, this.commands.length - KEPT);
        this.commandStart = null;
        this.commandLine = null;
        return;
      }
      case "D": {
        const running = this.commands.at(-1);
        if (running && running.end === null) {
          running.end = at();
          running.exitCode = exitOf(rest[0]);
        }
        return;
      }
      default:
        return;
    }
  }

  /** A command still open when the next prompt or command starts ended there, without a code. */
  private closeRunning(at: () => Position) {
    const running = this.commands.at(-1);
    if (running && running.end === null) running.end = at();
  }

  /**
   * The command whose output holds every selected row (zero-based buffer lines),
   * or null when the selection is not inside one command's output.
   */
  commandAt(startLine: number, endLine: number): ShellCommand | null {
    for (let at = this.commands.length - 1; at >= 0; at -= 1) {
      const command = this.commands[at];
      if (!command || command.outputStart.isDisposed) continue;
      if (startLine < command.outputStart.line) continue;
      const end = command.end;
      if (end && !end.row.isDisposed) {
        // The finish mark sits at the next prompt; its row counts only when output ended mid-line.
        const last = end.col > 0 ? end.row.line : end.row.line - 1;
        if (endLine > last) return null;
      }
      return command;
    }
    return null;
  }
}
