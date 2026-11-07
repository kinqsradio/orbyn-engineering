import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { PREVIEW_SCREENS, type PreviewScreenName } from "./previews";
import { UNAVAILABLE_REASON } from "./Unavailable";

const headings: Record<PreviewScreenName, string> = {
  account: "Sign in to Orbyn",
  "connect-planner": "Connect Orbyn Planner",
  "pair-phone": "Pair a phone",
  phone: "Threads",
  "phone-offline": "Threads",
};

describe("platform preview routes", () => {
  it.each(PREVIEW_SCREENS)("#/preview/%s renders its screen with every action disabled and explained", async (name) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    window.location.hash = `#/preview/${name}`;
    const { container } = render(<App />);
    await act(async () => {});
    expect(await screen.findAllByRole("heading", { name: headings[name] })).not.toHaveLength(0);
    expect(screen.getAllByText(/Sample data/).length).toBeGreaterThan(0);
    const actions = [...container.querySelectorAll("button, input, select, textarea, [role=switch]")];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-disabled", "true");
      expect(action).toHaveAttribute("aria-description", UNAVAILABLE_REASON);
      expect(action).toHaveAttribute("title", UNAVAILABLE_REASON);
    }
    expect(container.textContent).toContain(UNAVAILABLE_REASON);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
