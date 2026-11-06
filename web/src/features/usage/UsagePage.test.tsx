import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiFailure } from "../../api/client";
import type { UsageReport } from "../../api/types";
import { UsagePage } from "./UsagePage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function report(tokens: number, model = "local-model"): UsageReport {
  return {
    host_id: "local", scanned_at: "2026-11-05T00:00:00Z",
    engines: [{ engine: "claude", status: "scanned", files_scanned: 1, files_skipped: 0,
      models: [{ model, input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0,
        cache_write_tokens: 0, estimated_cost: null, cost_split: null,
        tiers: [{ tier: "standard", tokens, estimated_cost: null }], unpriced_tokens: tokens, days: [] }], days: [] }],
  };
}

const row = () => screen.getByRole("row", { name: /local-model/ });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "usage").mockResolvedValue(report(101));
});

it("keeps the same period mounted and uses the refresh response without another read", async () => {
  const refresh = deferred<UsageReport>();
  vi.spyOn(api, "refreshUsage").mockReturnValue(refresh.promise);
  render(<UsagePage />);
  expect(await screen.findByRole("row", { name: /local-model/ })).toHaveTextContent("101");
  const original = row();
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(row()).toBe(original);
  expect(screen.getByRole("status")).toHaveTextContent("Refreshing usage");
  await act(async () => refresh.resolve(report(202)));
  expect(row()).toBe(original);
  expect(row()).toHaveTextContent("202");
  expect(api.usage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
});

it("retains unpriced figures on refresh failure and retries the refresh", async () => {
  const refresh = deferred<UsageReport>();
  vi.spyOn(api, "refreshUsage").mockReturnValueOnce(refresh.promise).mockResolvedValue(report(303));
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await act(async () => refresh.reject(new ApiFailure("unavailable", "Local scan failed.", 503)));
  expect(row()).toHaveTextContent("101");
  expect(row()).toHaveTextContent("Unpriced");
  expect(screen.getByRole("alert")).toHaveTextContent("Local scan failed.");
  await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(row()).toHaveTextContent("303"));
  expect(api.refreshUsage).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["success", "failure"])("rejects an old period refresh %s without clearing the new pending read", async (outcome) => {
  const refresh = deferred<UsageReport>();
  const week = deferred<UsageReport>();
  vi.spyOn(api, "refreshUsage").mockReturnValue(refresh.promise);
  vi.mocked(api.usage).mockImplementation((days) => days === 7 ? week.promise : Promise.resolve(report(101)));
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
  expect(screen.queryByRole("row", { name: /local-model/ })).toBeNull();
  await act(async () => {
    if (outcome === "success") refresh.resolve(report(999));
    else refresh.reject(new ApiFailure("unavailable", "Old period error.", 503));
  });
  expect(screen.queryByRole("row", { name: /local-model/ })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh usage" })).toBeDisabled();
  await act(async () => week.resolve(report(707)));
  expect(row()).toHaveTextContent("707");
  expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
});

it("retries an initial read without pretending a previous report exists", async () => {
  vi.mocked(api.usage).mockRejectedValueOnce(new ApiFailure("unavailable", "History unavailable.", 503))
    .mockResolvedValue(report(404));
  render(<UsagePage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable.");
  expect(screen.queryByRole("table")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("row", { name: /local-model/ })).toHaveTextContent("404");
});

it("does not revive a refresh after leaving and returning to its period", async () => {
  const old = deferred<UsageReport>();
  vi.spyOn(api, "refreshUsage").mockReturnValue(old.promise);
  vi.mocked(api.usage).mockResolvedValueOnce(report(101)).mockResolvedValueOnce(report(707))
    .mockResolvedValueOnce(report(303));
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
  await waitFor(() => expect(row()).toHaveTextContent("707"));
  await userEvent.click(screen.getByRole("radio", { name: "30 days" }));
  await waitFor(() => expect(row()).toHaveTextContent("303"));
  await act(async () => old.resolve(report(999)));
  expect(row()).toHaveTextContent("303");
});

it("keeps provider selection when the same-period report refreshes", async () => {
  const both = (tokens: number): UsageReport => ({ ...report(tokens),
    engines: [...report(tokens).engines, { ...report(888, "second-model").engines[0]!, engine: "codex" }],
  });
  vi.mocked(api.usage).mockResolvedValue(both(101));
  vi.spyOn(api, "refreshUsage").mockResolvedValue(both(202));
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  await userEvent.click(screen.getByRole("button", { name: "All providers" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "claude" }));
  expect(screen.queryByRole("row", { name: /second-model/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() => expect(row()).toHaveTextContent("202"));
  expect(screen.queryByRole("row", { name: /second-model/ })).toBeNull();
  expect(screen.getByRole("button", { name: "claude" })).toBeVisible();
});

it("splits cost by token type and tier and keeps an unpriced tier unknown", async () => {
  const priced = report(300);
  priced.engines[0]!.models[0] = {
    ...priced.engines[0]!.models[0]!, estimated_cost: 18,
    cost_split: { input: 7, output: 10, cache_read: 1, cache_write: 0 },
    tiers: [
      { tier: "standard", tokens: 200, estimated_cost: 12 },
      { tier: "fast", tokens: 50, estimated_cost: 6 },
      { tier: "priority", tokens: 50, estimated_cost: null },
    ],
    unpriced_tokens: 50,
  };
  vi.mocked(api.usage).mockResolvedValue(priced);
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  await userEvent.click(screen.getByRole("radio", { name: "Cost" }));
  const split = screen.getByRole("region", { name: "Cost split" });
  expect(split).toHaveTextContent("Output$10.00");
  expect(split).toHaveTextContent("Fast · 50 tokens$6.00");
  expect(split).toHaveTextContent("Priority · 50 tokensUnpriced");
  expect(split).toHaveTextContent("Standard · 200 tokens$12.00");
  expect(within(split).getByRole("note")).toHaveTextContent("covers the standard tier only");
});

it("shows each model's cache hit, cost per million and trend", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const data = report(1_000_000);
  data.engines[0]!.models[0] = {
    ...data.engines[0]!.models[0]!, input_tokens: 500_000, cache_read_tokens: 500_000,
    estimated_cost: 3, cost_split: { input: 3, output: 0, cache_read: 0, cache_write: 0 },
    tiers: [{ tier: "standard", tokens: 1_000_000, estimated_cost: 3 }], unpriced_tokens: 0,
    days: [{ date: today, tokens: 1_000_000, estimated_cost: 3 }],
  };
  vi.mocked(api.usage).mockResolvedValue(data);
  render(<UsagePage />);
  const line = await screen.findByRole("row", { name: /local-model/ });
  expect(line).toHaveTextContent("50.0%");
  expect(line).toHaveTextContent("$3.00/M");
  expect(within(line).getByRole("img", { name: "local-model daily tokens" })).toBeInTheDocument();
});

it("draws a provider share bar and a daily cost chart for the period", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const data = report(300);
  data.engines[0]!.models[0] = { ...data.engines[0]!.models[0]!, estimated_cost: 3, unpriced_tokens: 0 };
  data.engines[0]!.days = [{ date: today, tokens: 300, estimated_cost: 3 }];
  data.engines.push({ ...report(100, "second-model").engines[0]!, engine: "codex",
    days: [{ date: today, tokens: 100, estimated_cost: null }] });
  vi.mocked(api.usage).mockResolvedValue(data);
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  const tokens = screen.getByRole("group", { name: "Share of tokens" });
  expect(within(tokens).getByLabelText("claude 75.0%")).toBeInTheDocument();
  expect(within(tokens).getByLabelText("codex 25.0%")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Cost" }));
  expect(within(screen.getByRole("group", { name: "Share of priced cost" })).getByLabelText("claude 100.0%")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Daily estimated cost by engine" })).toBeInTheDocument();
});

it("says what the local scan read, including engines with no history and unreadable files", async () => {
  const data = report(5);
  data.engines[0] = { ...data.engines[0]!, files_scanned: 3, files_skipped: 1 };
  data.engines.push({ engine: "codex", status: "no_history", files_scanned: 0, files_skipped: 0, models: [], days: [] });
  vi.mocked(api.usage).mockResolvedValue(data);
  render(<UsagePage />);
  const status = await screen.findByLabelText("Scan status");
  expect(status).toHaveTextContent("claude: 3 files, 1 unreadable");
  expect(status).toHaveTextContent("codex: no local history");
});

it("moves between the Usage and Limits tabs with the arrow keys and reads a meter as what is left", async () => {
  vi.spyOn(api, "limits").mockResolvedValue({
    pooled: [{ label: "5 hours", used_percent: 85, resets_at: null }],
    engines: [],
    unavailable: [],
  } as never);
  render(<UsagePage />);
  await screen.findByRole("row", { name: /local-model/ });
  const usage = screen.getByRole("tab", { name: "Usage" });
  const limits = screen.getByRole("tab", { name: "Limits" });
  expect(usage).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", usage.id);
  usage.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(limits).toHaveAttribute("aria-selected", "true");
  expect(limits).toHaveFocus();
  expect(await screen.findByRole("meter", { name: "5 hours" })).toHaveAttribute("aria-valuetext", "15% left");
  await userEvent.keyboard("{Home}");
  expect(usage).toHaveAttribute("aria-selected", "true");
});
