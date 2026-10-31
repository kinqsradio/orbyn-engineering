import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../api/types";
import { arrangeModels, effortValue, resolveModel, searchRows, shortModelName } from "./modelStore";
import { placeFloating } from "./ModelPicker";

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label: id,
  description: null,
  is_default: false,
  custom: false,
  options: [],
  ...over,
});

const effort = {
  id: "effort",
  label: "Reasoning",
  values: [
    { id: "low", label: "Low", default: false },
    { id: "medium", label: "Medium", default: true },
  ],
};

describe("model lists", () => {
  it("drops hidden models and honours the saved order", () => {
    const list = [model("a"), model("b"), model("c")];
    const arranged = arrangeModels("e", list, ["e:b"], ["e:c", "e:a"]);
    expect(arranged.map((entry) => entry.id)).toEqual(["c", "a"]);
  });

  it("falls back to the engine's default model and effort", () => {
    const listed = { engine: "e", source: "engine", error: null, fallback: false, checked_at: "", models: [model("a"), model("b", { is_default: true, options: [effort] })] };
    const picked = resolveModel(listed, null);
    expect(picked?.id).toBe("b");
    expect(effortValue(picked, null)?.id).toBe("medium");
    expect(effortValue(picked, "low")?.label).toBe("Low");
    expect(effortValue(model("x"), "low")).toBeNull();
  });

  it("matches every word and shortens vendor prefixes", () => {
    const rows = [
      { engine: "codex", model: model("gpt-6-luna", { label: "GPT-6-Luna" }) },
      { engine: "claude", model: model("opus", { label: "Claude Opus" }) },
    ];
    expect(searchRows(rows, "6 luna").map((row) => row.engine)).toEqual(["codex"]);
    expect(shortModelName("GPT-6-Luna")).toBe("6-Luna");
    expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
  });
});

describe("picker placement", () => {
  const anchor = { left: 800, right: 880, top: 400, bottom: 428 } as DOMRect;
  const size = { width: 362, height: 249 };

  it("opens below when it fits, keeping inside the window", () => {
    expect(placeFloating(anchor, size, { width: 1000, height: 900 })).toMatchObject({ left: 632, top: 432 });
  });

  it("flips above, then beside when neither fits", () => {
    expect(placeFloating(anchor, size, { width: 1400, height: 600 })).toMatchObject({ left: 800, top: 147 });
    const short = { ...anchor, top: 284, bottom: 312 } as DOMRect;
    expect(placeFloating(short, { width: 362, height: 340 }, { width: 1051, height: 534 }).left).toBe(434);
  });
});
