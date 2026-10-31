import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { startProject, threadIdOf, type PullFixture, type Service } from "./service";

/** The pull request surface through the real service and a stand-in `gh` that keeps state. */

const PATCH = "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more";
const fixtures: PullFixture[] = [
  {
    number: 1,
    title: "First layer",
    body: "Why this exists.",
    headRefName: "feat-one",
    baseRefName: "main",
    author: { login: "ada" },
    labels: [{ name: "bug" }],
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    checks: [
      { name: "unit", state: "SUCCESS", bucket: "pass", link: "https://example.com/1", workflow: "CI", description: "" },
      { name: "fork", state: "PENDING", bucket: "pending", link: "https://github.com/o/r/actions/runs/555", workflow: "CI", description: "Awaiting approval" },
    ],
    issueComments: [{ id: 11, body: "Looks close.", user: { login: "grace" }, created_at: "2026-10-01T00:00:00Z" }],
    threads: [
      {
        id: "T_1",
        isResolved: false,
        path: "src/a.ts",
        line: 2,
        comments: { nodes: [{ databaseId: 21, body: "Rename this.", author: { login: "grace" }, createdAt: "2026-10-01T00:00:00Z" }] },
      },
    ],
    timeline: [
      { id: 31, event: "labeled", actor: { login: "ada" }, created_at: "2026-10-01T00:00:00Z" },
      { id: 32, event: "reviewed", user: { login: "grace" }, submitted_at: "2026-10-02T00:00:00Z" },
    ],
    files: [
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
      { filename: "src/b.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+b" },
    ],
  },
  { number: 2, title: "Second layer", headRefName: "feat-two", baseRefName: "feat-one", isDraft: true, author: { login: "grace" }, labels: [{ name: "docs" }] },
  { number: 3, title: "Unrelated fix", headRefName: "fix-three", author: { login: "ada" } },
  { number: 4, title: "Old idea", headRefName: "old-four", state: "CLOSED", author: { login: "ada" } },
  { number: 5, title: "Shipped work", headRefName: "shipped-five", state: "MERGED", author: { login: "ada" } },
];

let service: Service;
let projectId = "";

const detail = (page: Page, title: string) => page.getByRole("article", { name: title });
const openPull = async (page: Page, title: string) => {
  await page.goto(`${service.page}#/pulls`);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(detail(page, title)).toBeVisible();
  return detail(page, title);
};
const moreAction = async (page: Page, article: Locator, name: string) => {
  await article.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name }).click();
};

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true, forge: fixtures }));
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1500, height: 1000 }));

test("the list filters by author, label, checks and draft, and sorts", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  const rows = page.locator(".pulls-list > li");
  await expect(rows).toHaveCount(3);
  const filter = async (group: string, value: string) => {
    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByRole("menuitem", { name: group }).click();
    await page.getByRole("menuitemradio", { name: value }).or(page.getByRole("menuitem", { name: value })).first().click();
  };
  await filter("Author", "grace");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Second layer");
  await filter("Author", "Anyone");
  await filter("Label", "bug");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("First layer");
  await filter("Label", "Any");
  await filter("Draft", "Drafts only");
  await expect(rows).toHaveCount(1);
  await filter("Draft", "All");
  await filter("Review", "Approved");
  await expect(rows).toHaveCount(1);
  await filter("Review", "All");
  await expect(rows).toHaveCount(3);
  await page.getByLabel("Search pull requests").fill("label:docs");
  await page.getByLabel("Search pull requests").press("Enter");
  await expect(rows).toHaveCount(1);
});

test("summary edits the title, description, base, reviewers and labels", async ({ page }) => {
  const article = await openPull(page, "First layer");
  await article.getByRole("button", { name: "Edit title" }).click();
  await article.getByLabel("Title").fill("First layer, renamed");
  await article.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "First layer, renamed" })).toBeVisible();
  const renamed = page.getByRole("article", { name: "First layer, renamed" });
  await renamed.getByRole("button", { name: "Edit description" }).click();
  await renamed.getByLabel("Description").fill("A better reason.");
  await renamed.getByRole("button", { name: "Save description" }).click();
  await expect(renamed.getByText("A better reason.")).toBeVisible();
  await renamed.getByLabel("Base branch").fill("develop");
  await renamed.getByLabel("Base branch").blur();
  await expect.poll(() => service.ghPull(1).baseRefName).toBe("develop");
  await renamed.getByRole("button", { name: "Change reviewers" }).click();
  await page.getByRole("menuitem", { name: "grace" }).or(page.getByRole("menuitemradio", { name: "grace" })).first().click();
  await expect(renamed.locator(".pull-people").first()).toContainText("grace");
  await renamed.getByRole("button", { name: "Change labels" }).click();
  await page.getByRole("menuitem", { name: "docs" }).or(page.getByRole("menuitemradio", { name: "docs" })).first().click();
  await expect(renamed.locator(".pull-people").nth(1)).toContainText("docs");
  await page.getByRole("button", { name: "Edit title" }).click();
  await renamed.getByLabel("Title").fill("First layer");
  await renamed.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail(page, "First layer")).toBeVisible();
  await detail(page, "First layer").getByLabel("Base branch").fill("main");
  await detail(page, "First layer").getByLabel("Base branch").blur();
  await expect.poll(() => service.ghPull(1).baseRefName).toBe("main");
});

test("checks show state and a fork's workflow is approved from here", async ({ page }) => {
  const article = await openPull(page, "First layer");
  await expect(article.getByRole("img", { name: "Passing" })).toBeVisible();
  await article.getByRole("button", { name: "Approve workflow" }).click();
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ").includes("actions/runs/555/approve"))).toBe(true);
});

test("comments edit, react, reply and resolve", async ({ page }) => {
  const article = await openPull(page, "First layer");
  const comment = article.getByRole("article", { name: "Comment by grace" }).first();
  await comment.getByRole("button", { name: "Edit comment" }).click();
  await comment.getByLabel("Edit comment text").fill("Looks done.");
  await comment.getByRole("button", { name: "Save" }).click();
  await expect(article.getByText("Looks done.")).toBeVisible();
  await article.getByRole("article", { name: "Comment by grace" }).first().getByRole("button", { name: "React" }).click();
  await page.getByRole("menuitem", { name: /rocket/ }).click();
  await expect.poll(() => (service.ghPull(1).issueComments as { reactions?: string[] }[])[0]?.reactions).toEqual(["rocket"]);

  await article.getByLabel("Reply on src/a.ts").fill("Done, renamed.");
  await article.getByRole("button", { name: "Reply" }).click();
  await expect(article.getByText("Done, renamed.")).toBeVisible();
  await article.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(article.getByText("Resolved", { exact: true })).toBeVisible();

  await article.getByLabel("Leave a comment").fill("Thanks.");
  await article.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(article.getByText("Thanks.")).toBeVisible();
});

test("the timeline filters by kind", async ({ page }) => {
  const article = await openPull(page, "First layer");
  await article.getByRole("tab", { name: "Timeline" }).click();
  await expect(article.locator(".pull-timeline li")).toHaveCount(2);
  await article.getByLabel("Filter activity").selectOption("labeled");
  await expect(article.locator(".pull-timeline li")).toHaveCount(1);
  await expect(article.locator(".pull-timeline li")).toContainText("ada");
});

test("the code tab marks files viewed and submits line comments as one review", async ({ page }) => {
  const article = await openPull(page, "First layer");
  await article.getByRole("tab", { name: "Code" }).click();
  await expect(article.getByRole("status")).toHaveText("0 of 2 files viewed");
  await article.getByRole("checkbox", { name: "Viewed src/b.ts" }).click();
  await expect(article.getByRole("status")).toHaveText("1 of 2 files viewed");
  await page.reload();
  await page.getByRole("button", { name: /First layer/ }).click();
  await page.getByRole("article", { name: "First layer" }).getByRole("tab", { name: "Code" }).click();
  const again = page.getByRole("article", { name: "First layer" });
  await expect(again.getByRole("status")).toHaveText("1 of 2 files viewed");

  await again.getByRole("button", { name: "Comment on line 2 of src/a.ts" }).focus();
  await again.getByRole("button", { name: "Comment on line 2 of src/a.ts" }).click();
  await again.getByLabel("Comment for line 2").fill("Not this name.");
  await again.getByRole("button", { name: "Add to review" }).click();
  await expect(again.getByRole("heading", { name: "Review, 1 comment" })).toBeVisible();
  await again.getByLabel("Review summary").fill("One thing.");
  await again.getByRole("button", { name: "Request changes" }).click();
  await expect.poll(() => service.ghPull(1).submitted).toMatchObject({
    event: "REQUEST_CHANGES",
    body: "One thing.",
    comments: [{ path: "src/a.ts", line: 2, body: "Not this name.", side: "RIGHT" }],
  });
});

test("the actions menu changes draft state, updates the branch and allows maintainer edits", async ({ page }) => {
  const article = await openPull(page, "Second layer");
  await moreAction(page, article, "Ready for review");
  await expect.poll(() => service.ghPull(2).isDraft).toBe(false);
  await moreAction(page, article, "Convert to draft");
  await expect.poll(() => service.ghPull(2).isDraft).toBe(true);
  await moreAction(page, article, "Update branch");
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ") === "pr update-branch 2")).toBe(true);
  await moreAction(page, article, "Update with rebase");
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ") === "pr update-branch 2 --rebase")).toBe(true);
  await moreAction(page, article, "Allow maintainer edits");
  await expect.poll(() => service.ghPull(2).maintainerCanModify).toBe(true);
  await moreAction(page, article, "Delete branch");
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ").includes("git/refs/heads/feat-two"))).toBe(true);
});

test("a stack shows its position, moves between layers and acts as one", async ({ page }) => {
  const article = await openPull(page, "First layer");
  const stack = article.getByRole("navigation", { name: "Stack" });
  await expect(stack).toContainText("1 of 2");
  await stack.getByRole("button", { name: "#2" }).click();
  await expect(detail(page, "Second layer").getByRole("navigation", { name: "Stack" })).toContainText("2 of 2");
  await detail(page, "Second layer").getByRole("button", { name: "Rebase stack" }).click();
  await expect.poll(() => service.ghCalls().filter((call) => call.join(" ").startsWith("pr update-branch 1 --rebase")).length).toBeGreaterThan(0);
});

test("merge takes a method, strips credits and can wait for checks; a row merges too", async ({ page }) => {
  const article = await openPull(page, "Second layer");
  await article.getByRole("button", { name: "Merge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Merge #2?" });
  await dialog.getByLabel("Commit message").fill("Second layer\n\nCo-Authored-By: Claude <noreply@example.com>");
  await dialog.getByLabel("Merge when checks pass").check();
  await dialog.getByLabel("Remove agent credits").check();
  await dialog.getByRole("button", { name: "Enable auto-merge" }).click();
  await expect(dialog).toBeHidden();
  await expect(article.getByText("Merges when checks pass")).toBeVisible();
  expect(service.ghPull(2).mergeBody).toBe("Second layer");

  await page.getByRole("button", { name: "Merge #3" }).click();
  await page.getByRole("dialog", { name: "Merge #3?" }).getByRole("button", { name: "Merge" }).click();
  await expect.poll(() => service.ghPull(3).state).toBe("MERGED");
});

test("a merged pull request can be reverted", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("menuitem", { name: "State" }).click();
  await page.getByRole("menuitemradio", { name: "Merged" }).or(page.getByRole("menuitem", { name: "Merged" })).first().click();
  await page.getByRole("button", { name: /Shipped work/ }).click();
  await moreAction(page, detail(page, "Shipped work"), "Revert changes");
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ") === "pr revert 5")).toBe(true);
});

test("rows close and reopen, one at a time or selected together", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  await page.getByRole("button", { name: "Close #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("CLOSED");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("menuitem", { name: "State" }).click();
  await page.getByRole("menuitemradio", { name: "All" }).or(page.getByRole("menuitem", { name: "All" })).first().click();
  await page.getByRole("button", { name: "Reopen #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("OPEN");
  await expect(page.getByRole("button", { name: "Close #1" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select #1" }).check();
  await page.getByRole("checkbox", { name: "Select #2" }).check();
  await page.getByRole("button", { name: "Close selected" }).click();
  await expect.poll(() => [service.ghPull(1).state, service.ghPull(2).state]).toEqual(["CLOSED", "CLOSED"]);
  await page.getByRole("button", { name: "Reopen #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("OPEN");
});

test("a thread links, watches and unlinks; Work on this opens a thread on the branch", async ({ page }) => {
  execFileSync("git", ["push", "-q", "origin", "main:refs/heads/feat-one"], { cwd: service.repo });
  const article = await openPull(page, "First layer");
  await moreAction(page, article, "Check out in a worktree");
  await expect(page.getByText("This checkout is not on the pull request's latest commit.")).toBeVisible();
  await article.getByRole("button", { name: "Work on this" }).click();
  await expect(page).toHaveURL(/#\/threads\//);
  const thread = threadIdOf(page);
  const current = await service.api<{ title: string; worktree: { branch: string } | null }>("GET", `/api/threads/${thread}`);
  expect(current.title).toBe("First layer");
  expect(current.worktree?.branch).toBe("feat-one");
  await expect.poll(async () => (await service.api<{ number: number }[]>("GET", `/api/threads/${thread}/pulls`)).map((pull) => pull.number)).toEqual([1]);

  await page.getByRole("button", { name: "Surfaces" }).click();
  await page.getByRole("button", { name: /Pull requests/ }).last().click();
  await page.getByRole("button", { name: "Watch #1" }).click();
  await expect(page.getByRole("button", { name: "Stop watching #1" })).toBeVisible();
  await page.getByRole("button", { name: "Unlink #1" }).click();
  await expect(page.getByText("No linked pull requests")).toBeVisible();
  await page.getByRole("button", { name: "Link a pull request" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a pull request" });
  await dialog.getByRole("button", { name: /#1 First layer/ }).click();
  await expect(page.getByRole("button", { name: /First layer/ })).toBeVisible();
  expect(projectId).not.toBe("");
});
