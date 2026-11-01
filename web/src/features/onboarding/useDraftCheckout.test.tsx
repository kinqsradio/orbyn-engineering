import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { PreferenceView } from "../../api/types";
import { useDraftCheckout } from "./useDraftCheckout";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const mocked = vi.mocked(request);
const a = { id: "a", is_git: true }, b = { id: "b", is_git: true };
const views = (value: string) => [{ key: "default_thread_env_mode", value }] as PreferenceView[];
beforeEach(() => { mocked.mockReset(); });

it("waits for the effective file-backed default and lets an explicit pick win", async () => {
  let resolve!: (value: PreferenceView[]) => void;
  mocked.mockImplementation(() => new Promise((done) => { resolve = done; }) as never);
  const { result } = renderHook(() => useDraftCheckout(a, null));
  expect(result.current.loading).toBe(true);
  act(() => result.current.setWorktree(null));
  await act(async () => resolve(views("worktree")));
  expect(result.current.worktree).toBeNull(); expect(result.current.loading).toBe(false);
});

it("uses a worktree default without requiring a manual checkout pick", async () => {
  mocked.mockResolvedValue(views("worktree") as never);
  const { result } = renderHook(() => useDraftCheckout(a, null));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.worktree).toBe("");
});

it("fences a previous project's late result and resets explicit scope", async () => {
  const pending: ((value: PreferenceView[]) => void)[] = [];
  mocked.mockImplementation(() => new Promise((done) => { pending.push(done as never); }) as never);
  const { result, rerender } = renderHook(({ project }) => useDraftCheckout(project, null), { initialProps: { project: a } });
  act(() => result.current.setWorktree("picked-a"));
  rerender({ project: b });
  expect(result.current.loading).toBe(true);
  await act(async () => pending[0]!(views("worktree")));
  expect(result.current.loading).toBe(true); expect(result.current.worktree).toBeNull();
  await act(async () => pending[1]!(views("local")));
  expect(result.current.loading).toBe(false); expect(result.current.worktree).toBeNull();
});

it("keeps reused worktrees and never applies a worktree to scratch or a plain folder", async () => {
  mocked.mockResolvedValue(views("local") as never);
  const { result, rerender } = renderHook(({ project, reused }) => useDraftCheckout(project, reused), {
    initialProps: { project: a as typeof a | null, reused: "existing" as string | null },
  });
  expect(result.current.worktree).toBe("existing");
  await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
  rerender({ project: { id: "plain", is_git: false }, reused: null });
  expect(result.current.worktree).toBeNull(); expect(result.current.loading).toBe(false);
  rerender({ project: null, reused: null }); expect(result.current.worktree).toBeNull();
});

it("reports an unavailable default instead of sending with a guessed checkout", async () => {
  mocked.mockRejectedValue(new ApiFailure("unavailable", "Settings unavailable", 503));
  const { result } = renderHook(() => useDraftCheckout(a, null));
  await waitFor(() => expect(result.current.error).toBe("Settings unavailable"));
  act(() => result.current.setWorktree(null));
  expect(result.current.error).toBeNull(); expect(result.current.worktree).toBeNull();
});
