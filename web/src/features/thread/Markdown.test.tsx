import { pullNumberOf } from "./MarkdownLink";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, safeHref } from "./Markdown";

describe("Markdown", () => {
  it("renders the supported blocks", () => {
    const { container } = render(
      <Markdown text={"## Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. first\n\n```rust\nlet a = 1;\n```\n\n> quote\n\n| A | B |\n| - | - |\n| 1 | 2 |"} />,
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("ul")?.children).toHaveLength(2);
    expect(container.querySelector("ol")).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe("let a = 1;");
    expect(container.querySelector("blockquote")?.textContent).toBe("quote");
    expect(container.querySelector("td")?.textContent).toBe("1");
  });

  it("keeps raw HTML as literal text", () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror="alert(1)"> **<b>x</b>**'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not link unsafe schemes", () => {
    const { container } = render(
      <Markdown text={"[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com)"} />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/");
    expect(links[0]).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("rejects schemes hidden by whitespace or control characters", () => {
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });

  it("renders an unterminated fence while streaming", () => {
    const { container } = render(<Markdown text={"```\nlet a"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("let a");
  });

  it("nests lists", () => {
    const { container } = render(<Markdown text={"- a\n  - b\n- c"} />);
    expect(container.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(container.querySelectorAll(":scope > div > ul > li")).toHaveLength(2);
  });
});

describe("pull request links", () => {
  it("reads the number from a host's address and nothing else", () => {
    expect(pullNumberOf("https://github.com/o/r/pull/42")).toBe(42);
    expect(pullNumberOf("https://github.com/o/r/pull/42/files#x")).toBe(42);
    expect(pullNumberOf("https://example.com/docs")).toBeNull();
  });
});
