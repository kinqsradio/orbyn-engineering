import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { goBack, resetTrail, useNavHistory } from "./navHistory";

const follow = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => resetTrail());

it("steps along the trail, and following a link to an address already seen is a new place, not Back", async () => {
  const { result } = renderHook(() => useNavHistory());
  expect(result.current).toEqual({ back: false, forward: false });
  await follow("#/a");
  await follow("#/b");
  expect(result.current).toEqual({ back: true, forward: false });
  await follow("#/a");
  expect(result.current).toEqual({ back: true, forward: false });
  act(() => goBack());
  await waitFor(() => expect(result.current).toEqual({ back: true, forward: true }));
  act(() => goBack());
  await waitFor(() => expect(result.current).toEqual({ back: true, forward: true }));
  await follow("#/c");
  expect(result.current).toEqual({ back: true, forward: false });
});
