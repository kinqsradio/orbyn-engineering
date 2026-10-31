import { describe, expect, it } from "vitest";
import type { EngineStatus } from "../../api/types";
import { chooseDraftEngine } from "./draftEngine";

const engine = (id: string, auth: EngineStatus["auth"], managed = true) =>
  ({ id, auth, capabilities: { managed } }) as EngineStatus;

describe("chooseDraftEngine", () => {
  const claudeOut = engine("claude", "logged_out");
  const codexIn = engine("codex", "logged_in");

  it("prefers a signed-in engine over one listed first", () => {
    expect(chooseDraftEngine([claudeOut, codexIn], null, false)).toBe(codexIn);
  });

  it("keeps the remembered engine while it is signed in", () => {
    const claudeIn = engine("claude", "logged_in");
    expect(chooseDraftEngine([claudeIn, codexIn], "codex", false)).toBe(codexIn);
  });

  it("leaves a remembered engine that has signed out", () => {
    expect(chooseDraftEngine([claudeOut, codexIn], "claude", false)).toBe(codexIn);
  });

  it("keeps a pick made in this draft even when signed out", () => {
    expect(chooseDraftEngine([claudeOut, codexIn], "claude", true)).toBe(claudeOut);
  });

  it("takes a managed engine over an unmanaged one", () => {
    const other = engine("other", "logged_in", false);
    expect(chooseDraftEngine([other, codexIn], null, false)).toBe(codexIn);
  });

  it("treats an unknown login as usable, and falls back to anything installed", () => {
    const unknown = engine("acp", "unknown");
    expect(chooseDraftEngine([claudeOut, unknown], null, false)).toBe(unknown);
    expect(chooseDraftEngine([claudeOut], null, false)).toBe(claudeOut);
    expect(chooseDraftEngine([], "codex", false)).toBeNull();
  });
});
