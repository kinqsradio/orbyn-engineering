import { describe, expect, it } from "vitest";
import { decodeCommandLine, ShellMarks, type Position } from "./shellMarks";

/** A screen of plain rows; a mark lands at the cursor the test sets. */
function screen(rows: string[]) {
  let cursor: Position = { row: { line: 0 }, col: 0 };
  const marks = new ShellMarks((fromLine, fromCol, toLine) =>
    rows.slice(fromLine, toLine).map((row, at) => (at === 0 ? row.slice(fromCol) : row)).join("\n"),
  );
  return {
    marks,
    at(line: number, col = 0) {
      cursor = { row: { line }, col };
    },
    mark(ident: number, data: string) {
      marks.mark(ident, data, () => cursor);
    },
  };
}

describe("shell marks", () => {
  it("reads the typed command and exit code around a command's output (OSC 133)", () => {
    const term = screen(["$ ls nope", "ls: nope: No such file", "$ "]);
    term.at(0, 2);
    term.mark(133, "A");
    term.mark(133, "B");
    term.at(1);
    term.mark(133, "C");
    term.at(2);
    term.mark(133, "D;1");
    expect(term.marks.commandAt(1, 1)).toMatchObject({ command: "ls nope", exitCode: 1 });
    // The prompt after the output, and the command line itself, are not output.
    expect(term.marks.commandAt(1, 2)).toBeNull();
    expect(term.marks.commandAt(0, 0)).toBeNull();
  });

  it("prefers the 633;E command line and decodes its escapes", () => {
    expect(decodeCommandLine("echo a\\x3bb \\\\n")).toBe("echo a;b \\n");
    const term = screen(["> git status", "clean", "> "]);
    term.at(0, 2);
    term.mark(633, "B");
    term.mark(633, "E;git status\\x3b true;nonce");
    term.at(1);
    term.mark(633, "C");
    term.at(2);
    term.mark(633, "D;0");
    expect(term.marks.commandAt(1, 1)).toMatchObject({ command: "git status; true", exitCode: 0 });
  });

  it("keeps a running command open and closes an unmarked one at the next prompt", () => {
    const term = screen(["$ sleep 9", "tick", "tick", "$ "]);
    term.at(0, 2);
    term.mark(133, "B");
    term.at(1);
    term.mark(133, "C");
    expect(term.marks.commandAt(1, 2)).toMatchObject({ command: "sleep 9", exitCode: null, end: null });
    term.at(3);
    term.mark(133, "A");
    expect(term.marks.commandAt(1, 2)).toMatchObject({ exitCode: null, end: { col: 0 } });
    expect(term.marks.commandAt(1, 3)).toBeNull();
  });

  it("counts the finish row when output ended mid-line, and ignores other OSC numbers", () => {
    const term = screen(["$ printf hi", "hi$ "]);
    term.at(0, 2);
    term.mark(133, "B");
    term.at(1);
    term.mark(133, "C");
    term.at(1, 2);
    term.mark(133, "D;0");
    term.mark(7, "D;9");
    expect(term.marks.commandAt(1, 1)).toMatchObject({ command: "printf hi", exitCode: 0 });
  });

  it("yields nothing when the shell emits no marks", () => {
    expect(screen(["$ ls", "a", "$ "]).marks.commandAt(1, 1)).toBeNull();
  });
});
