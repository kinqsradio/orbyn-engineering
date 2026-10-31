import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { startProject, type Service } from "./service";

/** The ACP registry section, against a local registry file. */
const PORT = 5286;
const REGISTRY_PORT = 5287;
const CATALOG = {
  agents: [
    { id: "pal", name: "Pal Agent", version: "1.0.0", description: "Helps out", distribution: { npx: { package: "pal-agent" } } },
    { id: "bare", name: "Bare Agent", version: "2.0.0", description: "Nothing to run", distribution: {} },
  ],
};

let service: Service;
let registry: Server;

test.beforeAll(async () => {
  registry = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(CATALOG));
  }).listen(REGISTRY_PORT);
  ({ service } = await startProject(PORT, { fakeEngines: true, registry: `http://127.0.0.1:${REGISTRY_PORT}/registry.json` }));
});

test.afterAll(() => {
  service.stop();
  registry.close();
});

test("an agent is found, added as a provider and removed", async ({ page }) => {
  await page.goto(`${service.page}#/settings/providers`);
  const section = page.getByRole("region", { name: "ACP registry" });
  await section.getByRole("searchbox", { name: "Search the ACP registry" }).fill("pal");
  await section.getByRole("button", { name: "Search" }).click();
  await expect(section.getByText("Pal Agent")).toBeVisible();
  await section.getByRole("button", { name: "Add through npx" }).click();
  await expect(section.getByRole("button", { name: "Remove Pal Agent" })).toBeVisible();
  const engines = () => service.api<{ id: string }[]>("GET", "/api/engines");
  await expect.poll(async () => (await engines()).some((engine) => engine.id === "acp-pal")).toBe(true);

  await section.getByRole("button", { name: "Remove Pal Agent" }).click();
  await expect(section.getByRole("button", { name: "Add through npx" })).toBeVisible();
  await expect.poll(async () => (await engines()).some((engine) => engine.id === "acp-pal")).toBe(false);
});
