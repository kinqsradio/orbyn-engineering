import { describe, expect, it } from "vitest";
import { useUi } from "../../state/ui";
import { terminalContextPrompt, terminalSelection, type TerminalExcerpt } from "./terminalContext";

const excerpt: TerminalExcerpt = { id: "e1", terminalId: "main", terminalLabel: "Terminal", lineStart: 2, lineEnd: 3, text: "hello\n世界" };

describe("terminal context", () => {
  it("captures buffer lines and normalizes line endings without trimming spaces", () => {
    expect(terminalSelection("\r\n  hello\r\n世界\r\n", { start: { y: 1 }, end: { y: 2 } })).toEqual({ text: "  hello\n世界", lineStart: 2, lineEnd: 3 });
    expect(terminalSelection(" \n", { start: { y: 0 }, end: { y: 0 } })).toBeNull();
    expect(terminalSelection("text", undefined)).toBeNull();
  });
  it("preserves exact excerpt text and contains embedded fences and slash controls", () => {
    const text = "/plan\n```\n<script>no</script>\n````\n世界";
    const prompt = terminalContextPrompt("explain", [{ ...excerpt, text }]);
    expect(prompt).toBe("explain\n\nTerminal excerpt: Terminal lines 2–3\n`````text\n" + text + "\n`````");
    expect(terminalContextPrompt("", [{ ...excerpt, text: "/plan" }])).toMatch(/^Terminal excerpt:/);
  });
  it("acknowledges only submitted identities and leaves another thread and newer items", () => {
    const ui = useUi.getState;
    ui().addTerminalContext("a", excerpt);
    ui().addTerminalContext("b", { ...excerpt, id: "b" });
    ui().addTerminalContext("a", { ...excerpt, id: "new" });
    ui().removeTerminalContexts("a", ["e1"]);
    expect(ui().terminalContexts.a?.map((item) => item.id)).toEqual(["new"]);
    expect(ui().terminalContexts.b?.map((item) => item.id)).toEqual(["b"]);
    expect(localStorage.getItem("orbyn.drafts.v1")).toBeNull();
  });
  it("refuses oversized context with existing draft and boundary overhead included", () => {
    useUi.getState().setDraft("a", "x".repeat(119_990));
    expect(useUi.getState().addTerminalContext("a", excerpt)).toBe(false);
    expect(useUi.getState().terminalContexts.a).toBeUndefined();
    expect(useUi.getState().drafts.a).toHaveLength(119_990);
    expect(useUi.getState().addTerminalContext("b", { ...excerpt, text: "x".repeat(120_001) })).toBe(false);
  });
  it("counts astral characters by codepoint at the complete prompt boundary", () => {
    const overhead = [...terminalContextPrompt("", [{ ...excerpt, text: "" }])].length;
    const atLimit = { ...excerpt, text: "😀".repeat(120_000 - overhead) };
    expect(useUi.getState().addTerminalContext("a", atLimit)).toBe(true);
    expect(useUi.getState().addTerminalContext("b", { ...atLimit, text: atLimit.text + "😀" })).toBe(false);
  });
});
