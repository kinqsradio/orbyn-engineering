import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TimelineRow } from "./items";
import type { ToolItem } from "./projection";
import { arrangeTimeline } from "./timeline";

const calls: ToolItem[] = Array.from({ length: 44 }, (_, n) => ({ kind: "tool", key: `tool:${n}`, callId: `${n}`, seq: n,
  runId: "r", ts: "", name: "Read", args: JSON.stringify({ path: `file${n}` }), output: "", result: `contents ${n}`, exitCode: 0, done: true }));

function Trace({ count }: { count: number }) {
  return arrangeTimeline(calls.slice(0, count), {}, "r").map((entry) => <TimelineRow key={entry.key} entry={entry} live tools={[]} />);
}

it("preserves an expanded recent tool and focus when another call arrives", async () => {
  const user = userEvent.setup();
  const view = render(<Trace count={43} />);
  await user.click(screen.getAllByRole("button", { name: "Read 5 files" })[0]!);
  const tool = screen.getByRole("button", { name: /^Read file15/ });
  await user.click(tool);
  expect(tool).toHaveAttribute("aria-expanded", "true");
  expect(tool).toHaveFocus();
  view.rerender(<Trace count={44} />);
  expect(screen.getByRole("button", { name: /^Read file15/ })).toBe(tool);
  expect(tool).toHaveAttribute("aria-expanded", "true");
  expect(tool).toHaveFocus();
});
