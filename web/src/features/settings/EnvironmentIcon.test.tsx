import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { EnvironmentIcon } from "./EnvironmentIcon";

it("draws the chosen machine kind and falls back to the monitor", () => {
  const { container, rerender } = render(<EnvironmentIcon icon="server" />);
  expect(container.querySelector("[data-environment-icon='server']")).not.toBeNull();
  expect(container.querySelector("svg")?.getAttribute("class")).toContain("server");
  rerender(<EnvironmentIcon icon="unknown-kind" />);
  expect(container.querySelector("svg")?.getAttribute("class")).toContain("monitor");
  rerender(<EnvironmentIcon icon={undefined} />);
  expect(container.querySelector("[data-environment-icon='default']")).not.toBeNull();
});
