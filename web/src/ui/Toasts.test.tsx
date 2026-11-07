import { render, screen } from "@testing-library/react";
import { act } from "react";
import { expect, it } from "vitest";
import { useUi } from "../state/ui";
import { Toasts } from "./Toasts";

it("leads a thread notice with a dot and a failure with a red cross, and a plain toast with neither", () => {
  render(<Toasts />);
  act(() => {
    useUi.getState().pushToast("Project icon picker needs you", "needs");
    useUi.getState().pushToast("Flaky E2E shard failed", "failed");
    useUi.getState().pushToast("Plain");
  });
  const [needs, failed, plain] = screen.getAllByText(/needs you|failed|Plain/).map((node) => node.parentElement!);
  expect(needs!.querySelector(".toast-dot")).not.toBeNull();
  expect(failed!.querySelector(".toast-failed")).not.toBeNull();
  expect(plain!.querySelector("svg, .toast-dot")).toBeNull();
});
