import { describe, expect, it } from "vitest";
import { PROMPT_CACHE_MS, offerCompact } from "./compactOffer";

const items = [{ ts: new Date("2026-11-05T10:00:00Z").toISOString() }];
const arrival = Date.parse("2026-11-05T10:10:00Z");

describe("compact offer", () => {
  it("offers compaction when a Claude thread is returned to after the cache expired", () => {
    expect(
      offerCompact({ engine: "claude", activeRun: false, items, arrivedAt: arrival, now: arrival }),
    ).toBe(true);
  });

  it("stays quiet inside the cache window, while running, and before any turn", () => {
    const last = Date.parse(items[0]!.ts);
    expect(
      offerCompact({ engine: "claude", activeRun: false, items, arrivedAt: last + PROMPT_CACHE_MS - 1000 }),
    ).toBe(false);
    expect(offerCompact({ engine: "claude", activeRun: true, items, arrivedAt: arrival })).toBe(false);
    expect(offerCompact({ engine: "claude", activeRun: false, items: [], arrivedAt: arrival })).toBe(false);
  });

  it("does not offer itself to an engine without a prompt cache", () => {
    expect(offerCompact({ engine: "codex", activeRun: false, items, arrivedAt: arrival })).toBe(false);
  });
});
