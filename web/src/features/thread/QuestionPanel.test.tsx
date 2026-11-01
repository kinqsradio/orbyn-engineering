import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { QuestionRequest } from "../../api/types";
import { QuestionPanel } from "./QuestionPanel";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const prose = "### Approach\n\nUse **small** steps and `checks`.\n\n- First\n- Next\n\n```ts\nconst safe = true;\n```\n\n<script>unsafe()</script>";
const baseAsk: QuestionRequest = { id: "request/1", thread_id: "t", run_id: "r", state: "pending", answers: null,
  decided_by: null, decided_at: null, created_at: "", questions: [
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
