import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { UsageReport } from "../../api/types";
import type { UsageDays } from "./usageModel";
import { useUsageReport } from "./useUsageReport";

it("refuses callbacks retained by an old period or a closed page", async () => {
  const report: UsageReport = { host_id: "local", scanned_at: "now", engines: [] };
  const get = vi.spyOn(api, "usage").mockResolvedValue(report);
  const post = vi.spyOn(api, "refreshUsage").mockResolvedValue(report);
  try {
    const hook = renderHook(({ days }: { days: UsageDays }) => useUsageReport(days), { initialProps: { days: 30 as UsageDays } });
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    const old = hook.result.current;
    hook.rerender({ days: 7 });
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    hook.rerender({ days: 30 });
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    await act(async () => { await old.reload(); await old.refresh(); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(post).not.toHaveBeenCalled();
    const current = hook.result.current;
    hook.unmount();
    await current.reload();
    await current.refresh();
    expect(get).toHaveBeenCalledTimes(3);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
