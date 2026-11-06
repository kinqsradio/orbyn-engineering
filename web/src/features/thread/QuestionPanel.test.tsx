import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, api, request } from "../../api/client";
import type { QuestionRequest, Thread } from "../../api/types";
import { useWorkspace } from "../../state/workspace";
import { QuestionPanel } from "./QuestionPanel";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const prose = "### Approach\n\nUse **small** steps and `checks`.\n\n- First\n- Next\n\n```ts\nconst safe = true;\n```\n\n<script>unsafe()</script>";
const baseAsk: QuestionRequest = { id: "request/1", thread_id: "t", run_id: "r", state: "pending", answers: null,
  attachments: null, decided_by: null, decided_at: null, created_at: "", questions: [
    { id: "choice", header: "Choice", question: prose, options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
      multi_select: false, allow_other: false, secret: false },
    { id: "followup", header: "", question: "Choose **follow-up**.", options: [], multi_select: false, allow_other: true, secret: false },
  ] };
let ask: QuestionRequest;
const mock = vi.mocked(request);
let open: boolean;
let fail: boolean;
beforeEach(() => {
  ask = structuredClone(baseAsk);
  open = true; fail = false; mock.mockReset();
  mock.mockImplementation(async (method) => {
    if (method === "GET") return (open ? [ask] : []) as never;
    if (fail) throw new ApiFailure("unavailable", "Answer could not be sent.", 503);
    open = false; return undefined as never;
  });
});

it("renders prose as Markdown, including headerless questions, and preserves answer identity/order", async () => {
  const user = userEvent.setup();
  const { container } = render(<QuestionPanel threadId="t" waiting />);
  expect(await screen.findByRole("heading", { name: "Approach" })).toBeVisible();
  const choice = screen.getByRole("group", { name: "Choice" });
  expect(within(choice).getByText("small").tagName).toBe("STRONG");
  expect(within(choice).getByRole("list").children).toHaveLength(2);
  expect(container.querySelector("pre code")).toHaveTextContent("const safe = true;");
  expect(container.querySelector("script")).toBeNull();
  expect(container).toHaveTextContent("<script>unsafe()</script>");
  expect(screen.getByText("follow-up").tagName).toBe("STRONG");
  expect([...container.querySelectorAll("fieldset")].map((element) => element.querySelector("legend")?.textContent))
    .toEqual(["Choice", "Choose **follow-up**."]);
  await user.click(within(choice).getByRole("button", { name: /A\s*First/ }));
  await user.click(within(choice).getByRole("button", { name: /B\s*Second/ }));
  const input = screen.getByRole("textbox", { name: "Choose **follow-up**." });
  await user.type(input, "  Keep this  ");
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/answer", { answers: { choice: ["B"], followup: ["Keep this"] } });
  await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
});

it("keeps picks and a custom answer after a failed submission", async () => {
  fail = true; const user = userEvent.setup();
  render(<QuestionPanel threadId="t" waiting />);
  await user.click(await screen.findByRole("button", { name: /A\s*First/ }));
  await user.type(screen.getByRole("textbox"), "Custom");
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Answer could not be sent.");
  expect(screen.getByRole("button", { name: /A\s*First/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("textbox")).toHaveValue("Custom");
  expect(screen.getByRole("button", { name: "Submit answers" })).toBeEnabled();
});

it("links remote question images without creating a media fetch element", async () => {
  ask.questions[0]!.question = "Choose **![Diagram](https://remote.example/diagram.svg)** or ![Other](http://remote.example/a.png).\n\n<svg onload=unsafe()></svg>";
  const { container } = render(<QuestionPanel threadId="t" waiting />);
  expect(await screen.findByRole("link", { name: "Diagram" })).toHaveAttribute("href", "https://remote.example/diagram.svg");
  expect(screen.getByRole("link", { name: "Other" })).toHaveAttribute("href", "http://remote.example/a.png");
  expect(container.querySelector("img, video, iframe, svg[onload], script")).toBeNull();
  expect(container).toHaveTextContent("<svg onload=unsafe()></svg>");
});

function atCheckout(cwd: string) {
  window.location.hash = "#/threads/t";
  const thread: Thread = { id: "t", project_id: "p", title: "Question", engine: "codex", model: null,
    cwd, worktree: null, skill_profile: null, scratch: false, active_run: null, last_run_state: null,
    created_at: "", updated_at: "" };
  useWorkspace.setState({ threads: { t: thread } });
}

it.each([
  ["/work/checkout", "docs/shot.png", "docs/shot.png"],
  ["/work/checkout", "docs/my%20shot.png", "docs/my shot.png"],
  ["/work/checkout", "/work/checkout/docs/shot.png", "docs/shot.png"],
  ["C:\\work\\checkout", "C:/work/checkout/docs/my%20shot.png", "docs/my shot.png"],
])("renders a checkout image in a question (%s, %s)", async (cwd, source, path) => {
  atCheckout(cwd);
  ask.questions[0]!.question = `Review **![Checkout diagram](${source})**.`;
  render(<QuestionPanel threadId="t" waiting />);
  const image = await screen.findByRole("img", { name: "Checkout diagram" });
  expect(image).toHaveAttribute("src", `/api/threads/t/files/raw?${new URLSearchParams({ path })}`);
  expect(screen.getByRole("button", { name: "Expand Checkout diagram" })).toBeVisible();
});

it("shows an unavailable checkout image without losing the question or answer", async () => {
  const user = userEvent.setup();
  atCheckout("/work/checkout");
  ask.questions[0]!.question = "Review ![Missing](docs/missing.png).";
  render(<QuestionPanel threadId="t" waiting />);
  const image = await screen.findByRole("img", { name: "Missing" });
  const option = screen.getByRole("button", { name: /A\s*First/ });
  await user.click(option);
  fireEvent.error(image);
  expect(screen.getByText("Image unavailable · Missing")).toBeVisible();
  expect(screen.queryByRole("img", { name: "Missing" })).toBeNull();
  expect(option).toBeEnabled();
  expect(option).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
});

it("leaves outside-root and file URLs inert in question prose", async () => {
  atCheckout("/work/checkout");
  const prose = "![Outside](/other/shot.png) ![Sibling](/work/checkout-other/shot.png) ![File](file:///work/checkout/shot.png)";
  ask.questions[0]!.question = prose;
  const { container } = render(<QuestionPanel threadId="t" waiting />);
  await screen.findByRole("region", { name: "Question from the agent" });
  expect(container.querySelector("img, video, iframe")).toBeNull();
  expect(container).toHaveTextContent(prose);
});

it("does not resolve checkout media without a thread route", async () => {
  atCheckout("/work/checkout");
  window.location.hash = "#/";
  ask.questions[0]!.question = "![Checkout](docs/shot.png)";
  const { container } = render(<QuestionPanel threadId="t" waiting />);
  await screen.findByRole("region", { name: "Question from the agent" });
  expect(container.querySelector("img")).toBeNull();
  expect(container).toHaveTextContent("![Checkout](docs/shot.png)");
});

it("dismisses without submitting selected or custom answers", async () => {
  const user = userEvent.setup(); render(<QuestionPanel threadId="t" waiting />);
  await user.click(await screen.findByRole("button", { name: "Dismiss" }));
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/dismiss", undefined);
  expect(mock.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
});

it("replaces a single choice with custom text and retains that answer after failure", async () => {
  ask.questions[0]!.allow_other = true;
  fail = true; const user = userEvent.setup();
  render(<QuestionPanel threadId="t" waiting />);
  const choice = await screen.findByRole("group", { name: "Choice" });
  const option = within(choice).getByRole("button", { name: /A\s*First/ });
  await user.click(option);
  const custom = within(choice).getByRole("textbox");
  await user.type(custom, "Different approach");
  expect(option).toHaveAttribute("aria-pressed", "false");
  expect(custom).toHaveFocus();
  await user.type(screen.getByRole("textbox", { name: "Choose **follow-up**." }), "Keep this");
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Answer could not be sent.");
  expect(custom).toHaveValue("Different approach");
  expect(option).toHaveAttribute("aria-pressed", "false");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/answer", {
    answers: { choice: ["Different approach"], followup: ["Keep this"] },
  });
});

it("selecting an offered answer by keyboard clears custom text", async () => {
  ask.questions[0]!.allow_other = true;
  const user = userEvent.setup(); render(<QuestionPanel threadId="t" waiting />);
  const choice = await screen.findByRole("group", { name: "Choice" });
  const custom = within(choice).getByRole("textbox");
  await user.type(custom, "Different approach");
  const option = within(choice).getByRole("button", { name: /B\s*Second/ });
  option.focus(); await user.keyboard("{Enter}");
  expect(custom).toHaveValue("");
  expect(option).toHaveAttribute("aria-pressed", "true"); expect(option).toHaveFocus();
  await user.type(custom, "  ");
  expect(option).toHaveAttribute("aria-pressed", "true");
  await user.clear(custom);
  expect(option).toHaveAttribute("aria-pressed", "true");
  await user.type(custom, "Replacement"); await user.clear(custom);
  expect(option).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
});

it("keeps multiple offered choices but switches exclusively between them and custom text", async () => {
  ask.questions[0]!.multi_select = true; ask.questions[0]!.allow_other = true;
  const user = userEvent.setup(); render(<QuestionPanel threadId="t" waiting />);
  const choice = await screen.findByRole("group", { name: "Choice" });
  const a = within(choice).getByRole("button", { name: /A\s*First/ });
  const b = within(choice).getByRole("button", { name: /B\s*Second/ });
  const custom = within(choice).getByRole("textbox");
  await user.click(a); await user.click(b);
  expect(a).toHaveAttribute("aria-pressed", "true"); expect(b).toHaveAttribute("aria-pressed", "true");
  await user.type(custom, "  ");
  expect(a).toHaveAttribute("aria-pressed", "true"); expect(b).toHaveAttribute("aria-pressed", "true");
  await user.type(custom, "Different approach");
  expect(a).toHaveAttribute("aria-pressed", "false"); expect(b).toHaveAttribute("aria-pressed", "false");
  await user.click(a); expect(custom).toHaveValue(""); await user.click(b);
  await user.type(screen.getByRole("textbox", { name: "Choose **follow-up**." }), "Keep this");
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/answer", {
    answers: { choice: ["A", "B"], followup: ["Keep this"] },
  });
});

it("uploads a file for a custom answer and keeps it with that question", async () => {
  const upload = vi.spyOn(api, "uploadAttachment").mockResolvedValue({
    id: "attachment/1", thread_id: "t", name: "trace.txt", mime: "text/plain", size: BigInt(5), created_at: "",
  });
  const user = userEvent.setup();
  render(<QuestionPanel threadId="t" waiting />);
  const choice = await screen.findByRole("group", { name: "Choice" });
  await user.click(within(choice).getByRole("button", { name: /A\s*First/ }));
  const followup = screen.getByRole("group", { name: "Choose **follow-up**." });
  await user.type(within(followup).getByRole("textbox"), "See the trace");
  const file = new File(["trace"], "trace.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("Attach a file to Choose **follow-up**."), file);
  expect(await screen.findByText("trace.txt")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/answer", {
    answers: { choice: ["A"], followup: ["See the trace"] },
    attachments: { followup: ["attachment/1"] },
  });
  expect(upload).toHaveBeenCalledWith("t", file);
});

it("keys 1-9 pick an option, and Enter submits only from the panel itself", async () => {
  ask.questions = [{ ...ask.questions[0]!, question: "See [the docs](https://example.com/docs)." }];
  const user = userEvent.setup();
  render(<QuestionPanel threadId="t" waiting />);
  const panel = await screen.findByRole("region", { name: "Question from the agent" });
  const first = within(panel).getByRole("button", { name: /A\s*First/ });
  first.focus();
  await user.keyboard("2");
  expect(within(panel).getByRole("button", { name: /B\s*Second/ })).toHaveAttribute("aria-pressed", "true");
  // A link keeps Enter for itself, so nothing is sent.
  within(panel).getByRole("link", { name: "the docs" }).focus();
  await user.keyboard("{Enter}");
  expect(mock).not.toHaveBeenCalledWith("POST", expect.anything(), expect.anything());
  panel.focus();
  await user.keyboard("{Enter}");
  expect(mock).toHaveBeenCalledWith("POST", "/api/questions/request%2F1/answer", { answers: { choice: ["B"] } });
});
