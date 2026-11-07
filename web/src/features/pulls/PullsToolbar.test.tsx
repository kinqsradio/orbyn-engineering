import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PullsToolbar } from "./PullsToolbar";
import { defaultSort, noFilters, pullData, type PullData, type PullFilters } from "./pullModel";

function Harness({
  initial = noFilters,
  onQuery,
  phone = false,
  oneRepo = true,
  has = pullData,
  loading = false,
}: {
  initial?: PullFilters;
  onQuery?(query: string): void;
  phone?: boolean;
  oneRepo?: boolean;
  has?: PullData;
  loading?: boolean;
}) {
  const [filters, setFilters] = useState(initial);
  const [sort, setSort] = useState(defaultSort);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  return (
    <PullsToolbar
      openCount={4}
      draftCount={1}
      loading={loading}
      filters={filters}
      onFilters={setFilters}
      sort={sort}
      onSort={setSort}
      text={text}
      onText={setText}
      tokens={tokens}
      onTokens={setTokens}
      onSubmit={(query) => onQuery?.(query)}
      projects={[{ id: "p", name: "orbyn-engineering", color: "blue", count: 2 }]}
      allCount={2}
      authors={["ada", "grace"]}
      labels={[{ name: "bug", count: 3 }]}
      shown={2}
      phone={phone}
      oneRepo={oneRepo}
      has={has}
    />
  );
}

const field = () => screen.getByRole("textbox", { name: "Search pull requests" });

describe("pull requests toolbar", () => {
  it("turns a typed label:bug into a removable token inside the one field", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "label:bug login");
    expect(screen.getByRole("button", { name: "Remove label:bug" })).toBeInTheDocument();
    expect(field()).toHaveValue("login");
    await user.click(screen.getByRole("button", { name: "Remove label:bug" }));
    expect(screen.queryByRole("button", { name: "Remove label:bug" })).not.toBeInTheDocument();
  });

  it("counts only the filters that are not defaults", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    unmount();
    render(<Harness initial={{ ...noFilters, review: ["approved"], checks: ["failing"] }} />);
    expect(screen.getByRole("button", { name: "Filters · 2" })).toBeInTheDocument();
  });

  it("removes one filter from its chip and all of them with Clear all", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...noFilters, review: ["approved"], checks: ["failing"] }} />);
    await user.click(screen.getByRole("button", { name: "Remove filter Checks: failing" }));
    expect(screen.getByRole("button", { name: "Filters · 1" })).toBeInTheDocument();
    expect(screen.queryByText("Checks: failing")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("focuses the search on / and clears it on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard("/");
    expect(field()).toHaveFocus();
    await user.keyboard("label:bug login");
    await user.keyboard("{Escape}");
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove label:bug" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("shows the live count on the phone sheet's footer button", async () => {
    const user = userEvent.setup();
    render(<Harness phone />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    expect(within(sheet).getByRole("button", { name: "Show 2 pull requests" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  it("says who matches, or that no one does, under the Author search", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(screen.getByRole("combobox", { name: "Search people" }), "gr");
    expect(screen.getByRole("option", { name: /grace/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Remove author grace" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search people" })).toHaveFocus();
    await user.clear(screen.getByRole("combobox", { name: "Search people" }));
    await user.type(screen.getByRole("combobox", { name: "Search people" }), "ril");
    expect(screen.getByText("No one matches “ril”")).toBeInTheDocument();
  });

  it("hides what the data cannot support yet, and draws it in place once it can", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("checkbox", { name: "Needs my review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Me" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    expect(screen.queryByRole("menuitemradio", { name: "Most comments" })).not.toBeInTheDocument();
    unmount();

    render(<Harness has={{ reviewRequests: true, viewerLogin: true, commentCount: true, createdAt: false }} />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("checkbox", { name: "Needs my review" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Me" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Updated", "Created", "Most comments", "Oldest"]);
  });

  it("offers Created and Oldest for one repository and not across several", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness oneRepo={false} />);
    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Updated"]);
    unmount();
    render(<Harness oneRepo />);
    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Updated", "Created", "Oldest"]);
  });
});

it("reads the Open and Drafts counts as an ellipsis while the list loads, never 0", () => {
  render(<Harness loading />);
  expect(screen.getByRole("button", { name: "Open · \u2026" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Drafts · \u2026" })).toBeInTheDocument();
});

describe("Filters popover focus", () => {
  const stops = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, [tabindex]')].filter(
      (element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled,
    );
  async function open() {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Filters" });
    await user.click(trigger);
    return { user, trigger, panel: screen.getByRole("dialog", { name: "Filters" }) };
  }

  it("Tab on the last field closes it and moves focus after the trigger", async () => {
    const { user, trigger, panel } = await open();
    stops(panel).at(-1)!.focus();
    await user.keyboard("{Tab}");
    expect(panel).toHaveAttribute("inert");
    expect(document.activeElement).not.toBe(trigger);
    expect(panel.contains(document.activeElement)).toBe(false);
    expect(trigger.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Tab walks the fields in order without closing", async () => {
    const { user, panel } = await open();
    const fields = stops(panel);
    fields[0]!.focus();
    await user.keyboard("{Tab}");
    expect(panel).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(fields[1]);
  });

  it("Shift+Tab on the first field goes to the trigger and keeps it open; a second one closes it", async () => {
    const { user, trigger, panel } = await open();
    stops(panel)[0]!.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(trigger).toHaveFocus();
    expect(panel).not.toHaveAttribute("inert");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(panel).toHaveAttribute("inert");
    expect(trigger.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("Escape closes it and returns focus to the trigger", async () => {
    const { user, trigger, panel } = await open();
    await user.keyboard("{Escape}");
    expect(panel).toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("an OS window blur does not close it", async () => {
    const { panel } = await open();
    fireEvent.blur(window);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(panel).not.toHaveAttribute("inert");
    expect(panel).not.toHaveAttribute("data-closing");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument());
  });
});
