import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { EngineStatus } from "../../api/types";
import { installMockFetch } from "../../test-support";
import { ProviderDetail } from "./ProviderDetail";

const engine = { id: "claude", name: "Claude Code", tier: "native", installed: true, version: "2.1.318", latest: null, auth: "logged_in", path: "/opt/claude",
  capabilities: {}, support: "tested", update_command: null, sign_in_command: null, updating: false, problem: null } as unknown as EngineStatus;
const store = { instances: [], raw: [], disabled: false, save: async () => null } as never;

async function seedCustomModels(mock: ReturnType<typeof installMockFetch>) {
  const read = mock.handle("POST", "/api/settings/preferences/query", { scope: {}, keys: ["custom_models"] }).body as { catalog: { version: string }; rows: { revision: string }[] };
  mock.handle("PUT", "/api/settings/preferences", { scope: {}, membership_version: read.catalog.version, if_match: { custom_models: read.rows[0]?.revision },
    edits: { custom_models: { op: "set", value: [{ engine: "claude", id: "wide", label: "sonnet-wide" }, { engine: "claude", id: "fast", label: "haiku-fast" }] } } });
}

it("gives only custom models arrows, disabled at the ends, and a Remove that is always there", async () => {
  const mock = installMockFetch();
  await seedCustomModels(mock);
  const user = userEvent.setup();
  render(<ProviderDetail engine={engine} store={store} onBack={() => undefined} onEdit={() => undefined} />);
  await screen.findByRole("switch", { name: "Show sonnet-wide" });
  expect(screen.queryByRole("button", { name: "Move Claude Sonnet up" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Claude Sonnet" })).toBeNull();
  expect(screen.getByRole("button", { name: "Move sonnet-wide up" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move sonnet-wide down" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Move haiku-fast down" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove sonnet-wide" })).toBeVisible();
  const rows = () => screen.getAllByRole("switch").map((item) => item.getAttribute("aria-label"));
  expect(rows().slice(-2)).toEqual(["Show sonnet-wide", "Show haiku-fast"]);
  await user.click(screen.getByRole("button", { name: "Move sonnet-wide down" }));
  await waitFor(() => expect(rows().slice(-2)).toEqual(["Show haiku-fast", "Show sonnet-wide"]));
  await user.click(screen.getByRole("button", { name: "Remove haiku-fast" }));
  await waitFor(() => expect(screen.queryByRole("switch", { name: "Show haiku-fast" })).toBeNull());
  expect(within(document.body).getByRole("switch", { name: "Show sonnet-wide" })).toBeVisible();
});

it("says which binary couldn't run, in the service's own words, with Check again", async () => {
  installMockFetch();
  render(<ProviderDetail engine={{ ...engine, problem: "This engine did not respond." }} store={store} onBack={() => undefined} onEdit={() => undefined} />);
  const banner = (await screen.findByText("Couldn’t run /opt/claude. This engine did not respond.")).closest<HTMLElement>("[role=alert]")!;
  expect(within(banner).getByRole("button", { name: "Check again" })).toBeVisible();
});
