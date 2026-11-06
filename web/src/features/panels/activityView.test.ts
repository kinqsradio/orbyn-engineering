import { expect, it } from "vitest";
import type { TimelineEntry } from "../thread/projection";
import { filterActivity, summarizeActivity } from "./activityView";

const at = (seq: number, label: string, ts: string): TimelineEntry => ({ seq, ts, label, detail: null, tone: "neutral" });
const log = [
  at(1, "Run started", "2026-01-01T00:00:00Z"),
  at(2, "Tool: Read", "2026-01-01T00:00:01Z"),
  at(3, "Tool: command", "2026-01-01T00:00:10Z"),
  at(4, "Tool: file_change", "2026-01-01T00:01:17Z"),
  at(5, "Files changed", "2026-01-01T00:01:17Z"),
  at(6, "Run finished", "2026-01-01T00:02:00Z"),
];

it("counts calls and the time from the first call to the last", () => {
  expect(summarizeActivity(log)).toBe("3 calls · 1m 16s");
});
it("hides the time with fewer than two timestamps, and says nothing without calls", () => {
  expect(summarizeActivity([log[0]!, log[1]!])).toBe("1 call");
  expect(summarizeActivity([log[0]!])).toBeNull();
  expect(summarizeActivity([at(1, "Tool: Read", "not a time"), at(2, "Tool: Read", "also not")])).toBe("2 calls");
});
it("filters to commands or edits and leaves All untouched", () => {
  expect(filterActivity(log, "all")).toHaveLength(6);
  expect(filterActivity(log, "commands").map((entry) => entry.seq)).toEqual([3]);
  expect(filterActivity(log, "edits").map((entry) => entry.seq)).toEqual([4, 5]);
});
