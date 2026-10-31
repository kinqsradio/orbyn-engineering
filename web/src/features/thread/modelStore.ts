import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../api/client";
import type { EngineModels, ModelInfo } from "../../api/types";

interface ModelState {
  byEngine: Record<string, EngineModels>;
  load(engine: string): Promise<void>;
}

const started = new Set<string>();

/** Engine model lists. The service keeps a good answer for five minutes. */
export const useModelStore = create<ModelState>((set) => ({
  byEngine: {},
  async load(engine) {
    if (started.has(engine)) return;
    started.add(engine);
    try {
      const models = await api.models(engine);
      set((state) => ({ byEngine: { ...state.byEngine, [engine]: models } }));
    } catch {
      started.delete(engine);
    }
  },
}));

export function useEngineModels(engine: string | null): EngineModels | null {
  const models = useModelStore((state) => (engine ? (state.byEngine[engine] ?? null) : null));
  const load = useModelStore((state) => state.load);
  useEffect(() => {
    if (engine) void load(engine);
  }, [engine, load]);
  return models;
}

/** The trigger's short name, without the vendor's prefix. */
export const shortModelName = (label: string) => label.replace(/^(gpt-|claude[ -])/i, "");

export const modelKey = (engine: string, model: string) => `${engine}:${model}`;

export function defaultModel(models: readonly ModelInfo[]): ModelInfo | null {
  return models.find((model) => model.is_default) ?? models[0] ?? null;
}

export function resolveModel(models: EngineModels | null, id: string | null): ModelInfo | null {
  if (!models) return null;
  return models.models.find((model) => model.id === id) ?? defaultModel(models.models);
}

export function effortOption(model: ModelInfo | null) {
  return model?.options.find((option) => option.id === "effort") ?? null;
}

export function effortValue(model: ModelInfo | null, effort: string | null) {
  const option = effortOption(model);
  if (!option) return null;
  return (
    option.values.find((value) => value.id === effort) ??
    option.values.find((value) => value.default) ??
    null
  );
}

export interface PickerRow {
  engine: string;
  model: ModelInfo;
}

/** Applies the viewer's hidden list and saved order to one engine's models. */
export function arrangeModels(
  engine: string,
  models: readonly ModelInfo[],
  hidden: readonly string[],
  order: readonly string[],
): ModelInfo[] {
  const rank = (model: ModelInfo) => {
    const at = order.indexOf(modelKey(engine, model.id));
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return models
    .filter((model) => !hidden.includes(modelKey(engine, model.id)))
    .map((model, index) => ({ model, index }))
    .sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
    .map((entry) => entry.model);
}

export function searchRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const text = `${row.model.label} ${row.model.id} ${row.engine}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
