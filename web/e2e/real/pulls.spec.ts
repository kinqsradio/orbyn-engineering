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
    commits: [
      {
        sha: "a1b2c3d4e5f6",
        commit: { message: "Rename the helper\n\nWith more detail.", committer: { date: "2026-10-01T00:00:00Z" } },
        author: { login: "ada" },
        files: [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH }],
      },
      {
        sha: "f6e5d4c3b2a1",
        commit: { message: "Add the second file", committer: { date: "2026-10-02T00:00:00Z" } },
        author: { login: "grace" },
        files: [{ filename: "src/b.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+b" }],
      },
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
/** Shows the side panel, with its tabs, unless the window is already wide enough to have it open. */
const openPanel = async (page: Page) => {
  const toggle = page.getByRole("button", { name: "Show side panel", exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
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

test("the list filters by author, label, checks and draft, and by a label typed in the search", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  const rows = page.locator(".pull-rows > li");
  await expect(rows).toHaveCount(3);
  const panel = page.getByRole("dialog", { name: "Filters" });
  /** A popover is hidden from the page at once but only leaves the DOM when its fade is over. */
  const popovers = page.locator(".pulls-pop");
  /** Opens Filters, runs the change, and closes it again with Escape. */
  const inPanel = async (change: () => Promise<void>) => {
    await page.getByRole("button", { name: /^Filters/ }).click();
    await change();
    await page.keyboard.press("Escape");
    await expect(popovers).toHaveCount(0);
  };
  const tick = (name: string) => inPanel(() => panel.getByRole("checkbox", { name: new RegExp(`^${name}( \\d+)?$`) }).click());
  const chip = (name: string) => page.getByRole("button", { name: `Remove filter ${name}` });

  await inPanel(async () => {
    await panel.getByLabel("Search people").fill("gra");
    await panel.getByRole("option", { name: /grace/ }).click();
  });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Second layer");
  await chip("Author: grace").click();
  await expect(rows).toHaveCount(3);

  await tick("bug");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("First layer");
  await chip("Label: bug").click();

  await inPanel(() => panel.getByRole("radio", { name: "Only" }).click());
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Filters · 1" })).toBeVisible();
  await chip("Draft: only").click();

  await tick("Approved");
  await expect(rows).toHaveCount(1);
  await chip("Review: approved").click();
  await expect(rows).toHaveCount(3);
  await tick("Passing");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("#1 ");
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(rows).toHaveCount(3);

  // A label typed in the search becomes a token and filters like the menu does.
  const search = page.getByLabel("Search pull requests");
  await search.fill("label:docs ");
  await expect(page.getByRole("button", { name: "Remove label:docs" })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await search.press("Escape");
  await expect(rows).toHaveCount(3);

});

test("the list sorts, switches state from the pills and comes back from a pull request", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  const rows = page.locator(".pull-rows > li");
  await expect(rows).toHaveCount(3);
  const panel = page.getByRole("dialog", { name: "Filters" });
  const sorted = async (item: string) => {
    await page.getByRole("button", { name: /^Sort:/ }).click();
    await page.getByRole("menuitemradio", { name: item }).click();
    await expect(page.locator(".pulls-pop")).toHaveCount(0);
  };
  await sorted("Oldest");
  await expect(rows.first()).toContainText("First layer");
  await sorted("Created");
  await expect(rows.first()).toContainText("Unrelated fix");

  const open = page.getByRole("button", { name: /^Open · / });
  const drafts = page.getByRole("button", { name: /^Drafts · / });
  await expect(open).toHaveAttribute("aria-pressed", "true");
  await drafts.click();
  await expect(drafts).toHaveAttribute("aria-pressed", "true");
  await expect(open).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await panel.getByRole("radio", { name: "Exclude" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".pulls-pop")).toHaveCount(0);
  await expect(open).toHaveAttribute("aria-pressed", "false");
  await expect(drafts).toHaveAttribute("aria-pressed", "false");
  await open.click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("button", { name: "Closed", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Old idea");
  await page.getByRole("button", { name: "Merged", exact: true }).click();
  await expect(rows).toContainText("Shipped work");
  await open.click();

  // A pull request is a page of its own in history: Back returns to the list.
  await page.getByRole("button", { name: /First layer/ }).click();
  await expect(page).toHaveURL(/#\/pulls\/[^/]+\/1$/);
  await expect(page.getByRole("article", { name: "First layer" })).toBeVisible();
  await page.goBack();
  await expect(rows).toHaveCount(3);
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
  // The pull request is in the address, so a reload stays on it, back on its Summary tab.
  await page.reload();
  await expect(page).toHaveURL(/#\/pulls\/[^/]+\/1$/);
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

test("the code tab shows one commit at a time, then every change again", async ({ page }) => {
  const article = await openPull(page, "First layer");
  await article.getByRole("tab", { name: "Code" }).click();
  const revision = article.getByRole("combobox", { name: "Revision" });
  await revision.selectOption({ label: "2. Add the second file (f6e5d4c)" });
  await expect(article.getByRole("status")).toHaveText("1 file in this commit");
  await expect(article.getByText("src/b.ts")).toBeVisible();
  await expect(article.getByText("src/a.ts")).toBeHidden();
  await expect(article.getByRole("button", { name: /^Comment on line/ })).toHaveCount(0);
  await article.getByRole("combobox", { name: "Revision" }).selectOption({ label: "All changes" });
  await expect(article.getByRole("status")).toHaveText(/of 2 files viewed/);
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

  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("button", { name: "Merge #3" }).click();
  await page.getByRole("dialog", { name: "Merge #3?" }).getByRole("button", { name: "Merge" }).click();
  await expect.poll(() => service.ghPull(3).state).toBe("MERGED");
});

test("a merged pull request can be reverted", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  await page.getByRole("button", { name: "Merged", exact: true }).click();
  await page.getByRole("button", { name: /Shipped work/ }).click();
  await moreAction(page, detail(page, "Shipped work"), "Revert changes");
  await expect.poll(() => service.ghCalls().some((call) => call.join(" ") === "pr revert 5")).toBe(true);
});

test("rows close and reopen, one at a time or selected together", async ({ page }) => {
  await page.goto(`${service.page}#/pulls`);
  await page.getByRole("button", { name: "Close #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("CLOSED");
  await page.getByRole("button", { name: "Closed", exact: true }).click();
  await page.getByRole("button", { name: "Reopen #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("OPEN");
  await page.getByRole("button", { name: /^Open · / }).click();
  await expect(page.getByRole("button", { name: "Close #1" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select #1" }).check();
  await page.getByRole("checkbox", { name: "Select #2" }).check();
  await page.getByRole("button", { name: "Close selected" }).click();
  await expect.poll(() => [service.ghPull(1).state, service.ghPull(2).state]).toEqual(["CLOSED", "CLOSED"]);
  await page.getByRole("button", { name: "Closed", exact: true }).click();
  await page.getByRole("button", { name: "Reopen #1" }).click();
  await expect.poll(() => service.ghPull(1).state).toBe("OPEN");
});

test("the PRs tab lists this thread's pull request and a thread without one says so", async ({ page }) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Surface menu" });
  await service.api("POST", `/api/threads/${thread.id}/pulls`, { number: 1 });
  await page.goto(`${service.page}#/threads/${thread.id}`);
  await openPanel(page);
  const tab = page.getByRole("tab", { name: "Pull requests", exact: true });
  await expect(tab).toHaveText("PRs");
  await tab.click();
  // The Details card above the tabs has a row for the same pull request.
  await page.locator(".linked-pulls").getByRole("button", { name: /First layer/ }).click();
  await expect(detail(page, "First layer")).toBeVisible();
  await expect(tab).toHaveCount(1);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(detail(page, "First layer")).toHaveCount(0);
  await expect(tab).toHaveCount(1);
  expect((await service.api<{ number: number }[]>("GET", `/api/threads/${thread.id}/pulls`)).map((pull) => pull.number)).toEqual([1]);

  const unlinked = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "No linked pull" });
  await page.goto(`${service.page}#/threads/${unlinked.id}`);
  await openPanel(page);
  await page.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await expect(page.getByText("No linked pull requests")).toBeVisible();
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

  await openPanel(page);
  await page.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await page.getByRole("button", { name: "Watch #1" }).click();
  await expect(page.getByRole("button", { name: "Stop watching #1" })).toBeVisible();
  await page.getByRole("button", { name: "Unlink #1" }).click();
  await expect(page.getByText("No linked pull requests")).toBeVisible();
  await page.getByRole("button", { name: "Link a pull request" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a pull request" });
  await dialog.getByRole("button", { name: /#1 First layer/ }).click();
  await expect(page.locator(".linked-pulls").getByRole("button", { name: /First layer/ })).toBeVisible();
  expect(projectId).not.toBe("");
});
