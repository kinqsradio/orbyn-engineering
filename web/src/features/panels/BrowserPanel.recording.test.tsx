import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PreviewTab } from "../../api/types";
import { BrowserPane } from "./BrowserPanel";

class FakeSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

beforeEach(() => { vi.stubGlobal("WebSocket", FakeSocket); });

function serve(recording: boolean) {
  const tab: PreviewTab = {
    id: "first", thread_id: "thread", url: "http://fixture/", title: "Synthetic page",
    control: "none", recording, viewers: 0, width: 400, height: 200,
    can_go_back: false, can_go_forward: false, zoom: 1, appearance: "system",
    mobile: false, private: false, profile: null, opened_by: "person", crashed: false,
  };
  let readsFail = false;
  const writes: string[] = [];
  let failedReads = 0;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.endsWith("/previews") && method === "GET") {
      if (readsFail) {
        failedReads++;
        return new Response(JSON.stringify({ code: "offline", message: "Synthetic read failure." }), { status: 503 });
      }
      return new Response(JSON.stringify([tab]));
    }
    if (path.includes("/recording") && method !== "GET") {
      writes.push(method);
      readsFail = true;
      return method === "DELETE"
        ? new Response(JSON.stringify({ path: "owned/synthetic", frames: 4 }))
        : new Response(null, { status: 204 });
    }
    return new Response("[]");
  });
  return { writes, failedReads: () => failedReads };
}

// These render the actual BrowserPane + useAsync polling owner. A refresh mock
// that rejects cannot reproduce useAsync.reload consuming the GET rejection.
it("a committed start retains Stop and exposes the actual GET failure despite stale false tab data", async () => {
  const server = serve(false);
  render(<BrowserPane threadId="thread" />);
  await userEvent.click(await screen.findByRole("button", { name: "Start recording" }));
  expect(await screen.findByRole("button", { name: "Stop recording" })).toBeEnabled();
  await waitFor(() => expect(server.failedReads()).toBeGreaterThan(0));
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic read failure.");
  expect(server.writes).toEqual(["POST"]);
});

it("a committed stop retains its receipt and Start despite stale true tab data and a failed GET", async () => {
  const server = serve(true);
  render(<BrowserPane threadId="thread" />);
  await userEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
  expect(await screen.findByText("Saved 4 frames.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic read failure.");
  expect(server.writes).toEqual(["DELETE"]);
});
