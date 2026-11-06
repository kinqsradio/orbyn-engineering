import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ReleaseChannel } from "../../generated/ReleaseChannel";
import { useUi } from "../../state/ui";
import { EnvironmentIdentity } from "./EnvironmentIdentity";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, info: vi.fn() } };
});

const serve = (channel: ReleaseChannel) =>
  vi.mocked(api.info).mockResolvedValue({ version: "0.4.1", remote: false, platform: "test", environment_label: "Test computer", channel });

beforeEach(() => useUi.getState().setPrefs({ environmentIdentification: "artwork" }));

it("shows Dev and Nightly artwork but nothing for a stable build", async () => {
  serve("dev");
  const { unmount } = render(<EnvironmentIdentity />);
  expect(await screen.findByText("Dev")).toHaveAttribute("data-channel", "dev");
  unmount();
  serve("stable");
  const { container } = render(<EnvironmentIdentity />);
  await act(async () => undefined);
  expect(container).toBeEmptyDOMElement();
});

it("shows a version pill or nothing, as chosen", async () => {
  serve("nightly");
  useUi.getState().setPrefs({ environmentIdentification: "pill" });
  const { container } = render(<EnvironmentIdentity />);
  expect(await screen.findByText("v0.4.1 Nightly")).toBeInTheDocument();
  act(() => useUi.getState().setPrefs({ environmentIdentification: "none" }));
  expect(container).toBeEmptyDOMElement();
});
