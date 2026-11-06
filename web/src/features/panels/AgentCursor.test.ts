import { expect, it } from "vitest";
import { cursorPoint, readPointer } from "./AgentCursor";

const cue = { sequence: 2, phase: "click", x: 200, y: 100, width: 1000, height: 500 };

it("fits frame coordinates into a letterboxed stage without applying zoom twice", () => {
  expect(cursorPoint(cue, 500, 500)).toEqual({ left: 100, top: 50 });
  expect(cursorPoint(cue, 1000, 250)).toEqual({ left: 100, top: 50 });
});

it("ignores stale, unbounded and malformed events", () => {
  expect(readPointer(JSON.stringify(cue), 1)).toEqual(cue);
  expect(readPointer(JSON.stringify(cue), 2)).toBeNull();
  for (const bad of [{ x: -1 }, { x: 1001 }, { width: 0 }, { phase: "type" }, { sequence: 2.5 }]) {
    expect(readPointer(JSON.stringify({ ...cue, ...bad }), 0)).toBeNull();
  }
  expect(readPointer("null", 0)).toBeNull();
  expect(readPointer("not json", 0)).toBeNull();
});
