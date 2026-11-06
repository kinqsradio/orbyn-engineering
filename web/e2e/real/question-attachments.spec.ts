import { expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** B47: a custom answer to an agent's question carries files picked in the browser. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("files picked for a custom answer stay with that question when it settles", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[question] [open-question] which file shows it?");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);

  const panel = page.getByRole("region", { name: "Question from the agent" });
  await expect(panel).toContainText("Which file shows it?");
  const pick = async (name: string, text: string) => {
    const chooser = page.waitForEvent("filechooser");
    await panel.getByText("Attach a file", { exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(panel.locator(".question-file", { hasText: name })).toBeVisible();
  };
  await pick("evidence.txt", "the evidence\n");
  await pick("wrong.txt", "not this one\n");
  await panel.getByRole("button", { name: "Remove wrong.txt" }).click();
  await expect(panel.locator(".question-file")).toHaveCount(1);

  await panel.getByRole("group", { name: "Evidence", exact: true }).getByRole("textbox").fill("See the attached file");
  const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/answer"));
  await panel.getByRole("button", { name: "Submit answers", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const sent = response.request().postDataJSON() as { answers: Record<string, string[]>; attachments: Record<string, string[]> };
  expect(sent.answers).toEqual({ q1: ["See the attached file"] });
  expect(sent.attachments.q1).toHaveLength(1);
  const [fileId] = sent.attachments.q1 ?? [];
  await expect(panel).toBeHidden();

  // The settled question keeps the file under its own question, and the bytes read back.
  const settledQuestion = (await response.json()) as { state: string; attachments: Record<string, string[]> };
  expect(settledQuestion.state).toBe("answered");
  expect(settledQuestion.attachments).toEqual({ q1: [fileId] });
  const kept = await service.api<{ state: string; attachments: Record<string, string[]> }[]>("GET", `/api/questions?thread_id=${id}`);
  expect(kept[0]?.attachments).toEqual({ q1: [fileId] });
  const content = await fetch(`${service.url}/api/attachments/${fileId}/content`, {
    headers: { Authorization: `Bearer ${new URL(service.page).searchParams.get("token")}` },
  });
  expect(await content.text()).toBe("the evidence\n");

  // The engine is told the typed answer; its protocol has no field for the file.
  await settled(service, id);
  const reply = page.locator(".msg-assistant").last();
  await expect(reply).toContainText("See the attached file");
  await expect(reply).not.toContainText(fileId ?? "missing");
});
