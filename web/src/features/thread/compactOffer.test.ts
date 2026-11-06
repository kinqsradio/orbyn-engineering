import { describe, expect, it } from "vitest";
import { LONG_PROMPT_CACHE_MS, PROMPT_CACHE_MS, offerCompact, promptCacheMs } from "./compactOffer";

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

  it("waits out the hour when Claude reports a one-hour cache write", () => {
    const usage = { total_tokens: 9, context_window: null, raw: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4 } } };
    expect(promptCacheMs(usage)).toBe(LONG_PROMPT_CACHE_MS);
    expect(offerCompact({ engine: "claude", activeRun: false, items, arrivedAt: arrival, usage })).toBe(false);
    const late = Date.parse(items[0]!.ts) + LONG_PROMPT_CACHE_MS + 1000;
    expect(offerCompact({ engine: "claude", activeRun: false, items, arrivedAt: late, now: late, usage })).toBe(true);
  });

  it("keeps the documented five minutes for a five-minute write or a report without the breakdown", () => {
    expect(promptCacheMs({ raw: { cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 } } })).toBe(PROMPT_CACHE_MS);
    expect(promptCacheMs({ raw: { input_tokens: 3 } })).toBe(PROMPT_CACHE_MS);
    expect(promptCacheMs(null)).toBe(PROMPT_CACHE_MS);
    expect(promptCacheMs({ raw: { cache_creation: { ephemeral_1h_input_tokens: "4" } } })).toBe(PROMPT_CACHE_MS);
  });

  it("does not offer itself to an engine without a prompt cache", () => {
    expect(offerCompact({ engine: "codex", activeRun: false, items, arrivedAt: arrival })).toBe(false);
  });
});
