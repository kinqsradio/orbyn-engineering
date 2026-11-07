import { beforeEach, expect, it } from "vitest";
import { resetTrail, visit } from "./navHistory";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { useNavHistory } from "./navHistory";

beforeEach(() => {
  resetTrail();
  window.location.hash = "";
});

it("enables Back after a move and Forward after stepping back, and a new place drops the way ahead", () => {
  const { result } = renderHook(() => useNavHistory());
  expect(result.current).toEqual({ back: false, forward: false });
  act(() => visit("#/usage"));
  expect(result.current).toEqual({ back: true, forward: false });
  act(() => visit(""));
  expect(result.current).toEqual({ back: false, forward: true });
  act(() => visit("#/tasks"));
  expect(result.current).toEqual({ back: true, forward: false });
});
