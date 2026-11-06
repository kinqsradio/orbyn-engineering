import { afterEach, expect, it } from "vitest";
import type { WireThreadEvent } from "../api/types";
import { useThreadLogs } from "./thread/threadLogs";
import { useUi } from "./ui";
import { permissionToasts, upgradeToast } from "./healthToasts";

afterEach(() => window.localStorage.clear());

const custom = (seq: number, name: string, value: unknown): WireThreadEvent =>
  ({ thread_id: "t", seq, run_id: null, ts: "", event: { type: "CUSTOM", name, value } }) as unknown as WireThreadEvent;

it("announces a database upgrade once per upgrade", () => {
  expect(upgradeToast({})).toBeNull();
  const first = upgradeToast({ database_upgrade: { from: 18, to: 24 } });
  expect(first).toContain("version 18 to 24");
  expect(upgradeToast({ database_upgrade: { from: 18, to: 24 } })).toBeNull();
  expect(upgradeToast({ database_upgrade: { from: 24, to: 25 } })).toContain("version 24 to 25");
});

it("names the new mode and says the running turn keeps its own", () => {
  const [text] = permissionToasts([custom(1, "permission.updated", { mode: "full_access", applies: "next_run" })]);
  expect(text).toContain("Full access");
  expect(text).toContain("next turn");
  expect(permissionToasts([custom(2, "thread.updated", { change: "permission_mode" })])).toEqual([]);
});

it("toasts a live permission change but not one replayed on first load", () => {
  const toasts = () => useUi.getState().toasts.map((toast) => toast.text);
  const before = toasts().length;
  useThreadLogs.getState().ingest("t", [custom(1, "permission.updated", { mode: "auto", applies: "next_run" })]);
  expect(toasts().length).toBe(before);
  useThreadLogs.getState().ingest("t", [custom(2, "permission.updated", { mode: "auto", applies: "next_run" })]);
  expect(toasts().at(-1)).toContain("Permission mode is now Auto");
});
