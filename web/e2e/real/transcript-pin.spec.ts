import { expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/** A transcript read at its end stays there when a question docks above the composer and the view shrinks. */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a docked question keeps the end of the transcript in view", async ({ page }) => {
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "A long answer first [scene:long]");
  await expect(page).toHaveURL(/#\/threads\//);
  const id = threadIdOf(page);
  await settled(service, id);
  await expect(page.getByText("Paragraph 120 of a long answer.")).toBeVisible();

  await send(page, "[question] [open-question] which file shows it?");
  await expect(page.getByRole("region", { name: "Question from the agent" })).toContainText("Which file shows it?");
  const transcript = page.getByRole("log");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2);
});
