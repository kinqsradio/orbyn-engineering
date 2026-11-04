import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { SiteIcon } from "./SiteIcon";
import { useBrowserHistory } from "./browserHistory";

beforeEach(() => {
  localStorage.clear();
  useBrowserHistory.setState({ icons: [] });
});

it("remembers a declared icon and restores it when a tab has no icon yet", async () => {
  const tab = { url: "https://example.com/page", private: false, favicon_url: "https://example.com/icon.png" };
  const { container, rerender } = render(<SiteIcon tab={tab} />);
  fireEvent.load(container.querySelector("img")!);
  await waitFor(() => expect(useBrowserHistory.getState().icons).toHaveLength(1));
  rerender(<SiteIcon tab={{ ...tab, favicon_url: undefined }} />);
  expect(container.querySelector("img")?.src).toContain("/api/media/image?");
  expect(container.querySelector("img")?.src).toContain("example.com%2Ficon.png");
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

it("never remembers private icons or restores a public icon into a private tab", () => {
  const { rerender, container } = render(<SiteIcon tab={{ url: "https://example.com/", private: true, favicon_url: "https://example.com/private.png" }} />);
  fireEvent.load(container.querySelector("img")!);
  expect(useBrowserHistory.getState().icons).toEqual([]);
  useBrowserHistory.getState().remember("https://example.com/", "https://example.com/public.png");
  rerender(<SiteIcon tab={{ url: "https://example.com/", private: true }} />);
  expect(container.querySelector("img")).toBeNull();
  expect(localStorage.getItem("orbyn.browser-icons.v1")).not.toContain("private.png");
});
