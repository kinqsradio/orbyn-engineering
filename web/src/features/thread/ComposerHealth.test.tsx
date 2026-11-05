import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { EngineStatus } from "../../api/types";
import { ComposerBanners } from "./ComposerExtras";

const healthy: EngineStatus = {
  id: "codex", name: "Codex", tier: "native", capabilities: {
    managed: true, streaming: true, approvals: true, resume: true,
    mcp: true, sandbox: true, skill_delivery: [], goal_control: true, decline_feedback: false,
    permission_modes: ["supervised", "auto_edits", "auto", "full_access"],
  },
  installed: true, path: "/engine", version: "0.160.0", auth: "logged_in",
  installer: "unknown", latest: null, support: "unknown", update_command: null,
  manual_hint: null, sign_in_command: null, updating: false, problem: null,
};

it("follows reported failures and recovery without treating unknown login as signed out", () => {
  const { rerender } = render(<ComposerBanners engine={healthy} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(<ComposerBanners engine={{ ...healthy, problem: "This engine did not respond." }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Codex: This engine did not respond.");
  rerender(<ComposerBanners engine={{ ...healthy, installed: false, auth: "logged_out" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("isn't installed");
  rerender(<ComposerBanners engine={{ ...healthy, auth: "logged_out" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("is signed out");
  rerender(<ComposerBanners engine={{ ...healthy, updating: true }} />);
  expect(screen.getByRole("status")).toHaveTextContent("is updating");
  rerender(<ComposerBanners engine={{ ...healthy, auth: "unknown" }} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(<ComposerBanners engine={null} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
