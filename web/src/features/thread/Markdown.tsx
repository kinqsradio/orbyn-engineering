import { useMemo, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";

/**
 * A small Markdown subset rendered to React elements. There is no HTML path:
 * anything that looks like a tag stays literal text, and links must be
 * http(s) or mailto. Partial input is fine, which is what streaming produces.
 */

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "rule" };

const FENCE = /^ {0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !(lines[at] ?? "").trimStart().startsWith(marker)) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      at += 1;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: heading[2] ?? "" });
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (at < lines.length) {
        const match = QUOTE.exec(lines[at] ?? "");
        if (!match) break;
        body.push(match[1] ?? "");
        at += 1;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(body) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = (item[1] ?? "").length;
      const marker = item[2] ?? "-";
      const ordered = /\d/.test(marker);
      const items: Block[][] = [];
      while (at < lines.length) {
        const current = LIST_ITEM.exec(lines[at] ?? "");
        if (!current || (current[1] ?? "").length !== indent || /\d/.test(current[2] ?? "") !== ordered) break;
        const body = [current[3] ?? ""];
        at += 1;
        while (at < lines.length) {
          const next = lines[at] ?? "";
          if (next.trim() === "") {
            const after = lines[at + 1] ?? "";
            if (/^\s+\S/.test(after) && after.search(/\S/) > indent) {
              body.push("");
              at += 1;
              continue;
            }
            break;
          }
          const nested = LIST_ITEM.exec(next);
          if (nested && (nested[1] ?? "").length <= indent) break;
          if (!nested && !/^\s/.test(next)) {
            body.push(next);
            at += 1;
            continue;
          }
          body.push(next.slice(Math.min(indent + 2, next.search(/\S/))));
          at += 1;
        }
        items.push(parseBlocks(body));
      }
      blocks.push({ type: "list", ordered, start: ordered ? Number.parseInt(marker, 10) : 1, items });
      continue;
    }

    if (line.includes("|") && TABLE_DIVIDER.test(lines[at + 1] ?? "")) {
      const head = tableCells(line);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && (lines[at] ?? "").includes("|") && (lines[at] ?? "").trim() !== "") {
        rows.push(tableCells(lines[at] ?? ""));
        at += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const body: string[] = [];
    while (at < lines.length) {
      const next = lines[at] ?? "";
      const interrupted =
        next.trim() === "" ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        RULE.test(next) ||
        QUOTE.test(next) ||
        LIST_ITEM.test(next);
      if (interrupted && body.length > 0) break;
      body.push(next);
      at += 1;
    }
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Control characters and whitespace can hide a scheme from a naive check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|(?<![\w])_([^\s_](?:[\s\S]*?[^\s_])?)_(?![\w])|~~([\s\S]+?)~~|\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}${index++}`;
    const [whole, , code, bold1, bold2, em1, em2, strike, linkText, linkHref, bare] = match;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(<strong key={key}>{renderInline(bold1 ?? bold2 ?? "", `${key}-`)}</strong>);
    else if (em1 !== undefined || em2 !== undefined)
      out.push(<em key={key}>{renderInline(em1 ?? em2 ?? "", `${key}-`)}</em>);
    else if (strike !== undefined)
      out.push(<del key={key}>{renderInline(strike, `${key}-`)}</del>);
    else if (linkText !== undefined) {
      const href = safeHref(linkHref ?? "");
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(linkText, `${key}-`)}
          </a>
        ) : (
          whole
        ),
      );
    } else if (bare !== undefined) {
      const href = safeHref(bare);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {bare}
          </a>
        ) : (
          bare
        ),
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string): ReactNode[] {
  const parts = text.split("\n");
  return parts.flatMap((part, at) => {
    const nodes = renderInline(part, `l${at}-`);
    return at < parts.length - 1 ? [...nodes, <br key={`br${at}`} />] : nodes;
  });
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level + 1}` as "h2" | "h3" | "h4" | "h5";
      return <Tag key={key}>{renderInline(block.text)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{withBreaks(block.text)}</p>;
    case "code":
      return <CodeBlock key={key} code={block.text} lang={block.lang} />;
    case "quote":
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case "list": {
      const children = block.items.map((item, at) => <li key={at}>{item.map(renderBlock)}</li>);
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {children}
        </ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    }
    case "table":
      return (
        <div key={key} className="md-table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, at) => (
                  <th key={at}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                <tr key={at}>
                  {block.head.map((_, cell) => (
                    <td key={cell}>{renderInline(row[cell] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text.split(/\r\n|\n|\r/)), [text]);
  return <div className="md">{blocks.map(renderBlock)}</div>;
}
