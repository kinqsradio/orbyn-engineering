import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAsync } from "./useAsync";

describe("useAsync", () => {
  it("applies only the current key's result", async () => {
    const resolvers: Record<string, (value: string) => void> = {};
    const { result, rerender } = renderHook(
      ({ id }) =>
        useAsync(id, () => new Promise<string>((resolve) => (resolvers[id] = resolve))),
      { initialProps: { id: "a" } },
    );
    await waitFor(() => expect(resolvers.a).toBeDefined());
    rerender({ id: "b" });
    await waitFor(() => expect(resolvers.b).toBeDefined());
    act(() => resolvers.b?.("b result"));
    await waitFor(() => expect(result.current.data).toBe("b result"));
    act(() => resolvers.a?.("a result"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(result.current.data).toBe("b result");
  });

  it("keeps prior data on a failed reload and recovers on retry", async () => {
    let fail = false;
    const { result } = renderHook(() =>
      useAsync("k", async () => {
        if (fail) throw new Error("no");
        return "ok";
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    fail = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toBe("ok");
    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});
