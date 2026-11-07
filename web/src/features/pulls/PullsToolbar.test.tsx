import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PullsToolbar } from "./PullsToolbar";
import { defaultSort, noFilters, type PullFilters } from "./pullModel";

function Harness({ initial = noFilters, onQuery }: { initial?: PullFilters; onQuery?(query: string): void }) {
  const [filters, setFilters] = useState(initial);
  const [sort, setSort] = useState(defaultSort);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  return (
    <PullsToolbar
      openCount={4}
      draftCount={1}
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
      authors={["ada"]}
      labels={[{ name: "bug", count: 3 }]}
      shown={2}
      phone={false}
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
});
