import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocx, buildXlsx, docxParagraph, worksheet } from "../../src/features/panels/office.test-support";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * Word and spreadsheet files through the real service, in a real browser: the
 * worker really spawns, `DecompressionStream` really inflates the package, and
 * `DOMParser` really reads the XML. The unit tests run the same parser under Node
 * with a stand-in worker, which is why this exists.
 */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a Word document and a spreadsheet open in the viewer", async ({ page }) => {
  writeFileSync(
    join(service.repo, "report.docx"),
    buildDocx(docxParagraph("Quarterly report") + docxParagraph("Revenue grew by twelve percent.")),
  );
  writeFileSync(
    join(service.repo, "totals.xlsx"),
    buildXlsx(
      [
        {
          name: "Summary",
          xml: worksheet(
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
              '<row r="2"><c r="A2"><v>7</v></c><c r="B2"><v>42</v></c></row>',
          ),
        },
        { name: "Empty", xml: worksheet("") },
      ],
      ["Count", "Total"],
    ),
  );

  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:timeline] hello");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));

  const open = async (name: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox", { name: "Search" }).fill(name);
    await palette.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) }).first().click();
  };

  // A .docx reads as text, and the view toggle is offered.
  await open("report.docx");
  await expect(page.getByText("Quarterly report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Revenue grew by twelve percent.")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Document view" })).toBeVisible();

  // A .xlsx reads as sheets with their real cells.
  await open("totals.xlsx");
  const sheets = page.getByRole("tablist", { name: "Sheets" });
  await expect(sheets.getByRole("tab", { name: "Summary" })).toBeVisible({ timeout: 20_000 });
  const summary = page.getByRole("tabpanel", { name: "Summary" });
  await expect(summary).toContainText("Count");
  await expect(summary).toContainText("Total");
  await expect(summary).toContainText("42");
  // A second, empty sheet is still a tab of its own.
  await expect(sheets.getByRole("tab", { name: "Empty" })).toBeVisible();
  await sheets.getByRole("tab", { name: "Empty" }).click();
  await expect(page.getByRole("tabpanel", { name: "Empty" })).toBeVisible();
});