import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useThreadLogs } from "./state/threadLogs";
import { useUi } from "./state/ui";
import { useWorkspace } from "./state/workspace";

afterEach(() => {
  cleanup();
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useThreadLogs.setState(useThreadLogs.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
  stubBrowser();
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubBrowser() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}
stubBrowser();

Element.prototype.scrollTo ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

