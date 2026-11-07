import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { AcpRegistryPage, HistoryImportPage } from "./ProviderPages";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
vi.mock("../../state/workspace", () => ({ useWorkspace: Object.assign((select: (state: unknown) => unknown) => select({ refreshEngines: vi.fn() }), { getState: () => ({ refreshAll: vi.fn() }) }) }));

it("filters the registry as you type and says when nothing matches", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockResolvedValue([
    { id: "gemini", name: "Gemini CLI", version: "1", description: "Google", installable: ["npx"], engine: "gemini" },
    { id: "goose", name: "Goose", version: "1", description: "Block", installable: ["binary"], engine: null },
  ]);
  render(<AcpRegistryPage onBack={() => undefined} />);
  expect(await screen.findByText("Installed")).toBeVisible();
  await user.type(screen.getByRole("textbox", { name: "Find an agent" }), "goos");
  expect(screen.getByRole("button", { name: "Add Goose" })).toBeVisible();
  await user.type(screen.getByRole("textbox", { name: "Find an agent" }), "x");
  expect(screen.getByText("No agent matches “goosx”")).toBeVisible();
});

it("imports exactly the sessions that are ticked", async () => {
  const user = userEvent.setup();
  const session = (id: string, importable = true) => ({ engine: "claude", session_id: id, title: `Session ${id}`, cwd: "/code/app", updated_at: "2026-11-06T10:00:00Z", importable, thread_id: null, project_id: "p" });
  vi.mocked(request).mockImplementation(async (_method, path) => {
    if (path === "/api/history/sessions") return { sessions: [session("a"), session("b"), session("c", false)], truncated: false } as never;
    return { thread_id: "t" } as never;
  });
  render(<HistoryImportPage onBack={() => undefined} />);
  expect(await screen.findByText("Found 3 sessions in 1 projects")).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: "Import Session b" }));
  const go = screen.getByRole("button", { name: "Import 1 session" });
  await user.click(go);
  await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/history/import", { engine: "claude", session_id: "a" }));
  expect(request).not.toHaveBeenCalledWith("POST", "/api/history/import", { engine: "claude", session_id: "b" });
});
