import { expect, it, vi } from "vitest";
import { StarPromptSession } from "./starPrompt";

const ledger = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

it("waits for six successful sends and retains a separate dismissal across sessions", async () => {
  const storage = ledger();
  let dismiss: (() => void) | undefined;
  const show = vi.fn((close: () => void) => { dismiss = close; });
  const check = vi.fn(async () => false);
  const session = new StarPromptSession(() => storage, check, show);
  for (let index = 0; index < 5; index++) await session.sent();
  expect(check).not.toHaveBeenCalled();
  await Promise.all([session.sent(), session.sent()]);
  expect(check).toHaveBeenCalledOnce(); expect(show).toHaveBeenCalledOnce();
  dismiss?.();
  const next = new StarPromptSession(() => storage, check, show);
  for (let index = 0; index < 8; index++) await next.sent();
  expect(show).toHaveBeenCalledOnce();
  expect(storage.values.get("orbyn:github-star:sent")).toBe("6");
  expect(storage.values.get("orbyn:github-star:dismissed")).toBe("true");
});

it("suppresses the notice if storage cannot retain its dismissal", async () => {
  const show = vi.fn(); const check = vi.fn(async () => false);
  const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const session = new StarPromptSession(() => storage, check, show);
  for (let index = 0; index < 8; index++) await session.sent();
  expect(show).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
});

it("remembers an existing star and never presents the notice", async () => {
  const storage = ledger(); const show = vi.fn();
  const session = new StarPromptSession(() => storage, async () => true, show);
  for (let index = 0; index < 6; index++) await session.sent();
  const next = new StarPromptSession(() => storage, async () => false, show);
  await next.sent(); expect(show).not.toHaveBeenCalled();
});

it("a dismissal from another tab wins over an older pending check", async () => {
  const storage = ledger();
  storage.values.set("orbyn:github-star:sent", "5");
  let finish!: (value: boolean) => void;
  const slowNotice = vi.fn();
  const slow = new StarPromptSession(() => storage, () => new Promise((resolve) => { finish = resolve; }), slowNotice);
  const pending = slow.sent();
  const other = new StarPromptSession(() => storage, async () => false, (close) => close());
  await other.sent(); finish(false); await pending;
  expect(slowNotice).not.toHaveBeenCalled();
  expect(storage.values.get("orbyn:github-star:dismissed")).toBe("true");
});
