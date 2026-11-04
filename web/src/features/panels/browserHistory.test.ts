import { beforeEach, expect, it } from "vitest";
import { iconUrl, proxyIconUrl, readIcons, useBrowserHistory } from "./browserHistory";

beforeEach(() => {
  localStorage.clear();
  useBrowserHistory.setState({ icons: [] });
});

it("keeps icon addresses within the image proxy's URL envelope", () => {
  expect(iconUrl("https://example.com:443/icon.png#part")).toBe("https://example.com/icon.png");
  for (const url of ["http://example.com/i", "data:image/png,a", "file:///i", "https://user:pass@example.com/i", "https://example.com:444/i", "x", "https://example.com/" + "x".repeat(4096)]) {
    expect(iconUrl(url)).toBeNull();
  }
});

it("bounds and validates persisted history, replacing each page's icon", () => {
  const store = useBrowserHistory.getState();
  for (let index = 0; index < 55; index++) store.remember(`https://example.com/${index}`, "https://example.com/i.png");
  store.remember("https://example.com/54", "https://example.com/new.png");
  const icons = useBrowserHistory.getState().icons;
  expect(icons).toHaveLength(50);
  expect(icons[0]).toEqual({ page: "https://example.com/54", icon: "https://example.com/new.png" });
  expect(readIcons(JSON.parse(localStorage.getItem("orbyn.browser-icons.v1")!))).toEqual(icons);
  expect(readIcons([null, { page: "file:///secret", icon: "https://example.com/i" }, ...icons, icons[0]])).toEqual(icons);
  expect(readIcons({ icons })).toEqual([]);
});

it("serves through the same service endpoint instead of the remote origin", () => {
  const proxy = new URL(proxyIconUrl("https://example.com/icon.png"), window.location.origin);
  expect(proxy.pathname).toBe("/api/media/image");
  expect(proxy.searchParams.get("url")).toBe("https://example.com/icon.png");
});
