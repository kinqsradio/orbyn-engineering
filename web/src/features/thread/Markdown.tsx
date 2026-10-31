import { Check, ChevronRight, Copy } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Collapsible } from "../../ui/Collapsible";
import { CodeBlock } from "./CodeBlock";
import { MarkdownImage } from "./MarkdownImage";
import { ExternalLink, FileLink, fileLinkTarget, threadLinkId, ThreadLink } from "./MarkdownLink";
import { Mermaid } from "./Mermaid";
import { Tex } from "./Tex";

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
  | { type: "table"; head: string[]; rows: string[][]; aligns: Align[] }
  | { type: "details"; summary: string; blocks: Block[] }
  | { type: "math"; source: string }
  | { type: "rule" };

type Align = "left" | "right" | "center" | null;

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

const columnAligns = (divider: string): Align[] =>
  tableCells(divider).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });

const NUMERIC = /^[-+]?[\d,.]+%?$/;

/** A column with no stated alignment reads as numbers when all its cells do. */
const resolveAligns = (aligns: Align[], rows: string[][]): Align[] =>
  aligns.map((align, column) => {
    if (align) return align;
    const cells = rows.map((row) => row[column]?.trim() ?? "").filter(Boolean);
    return cells.length > 0 && cells.every((cell) => NUMERIC.test(cell)) ? "right" : null;
  });

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }

    // Only this exact shape counts; other tags stay literal text.
    if (/^\s*<details>\s*$/.test(line)) {
      const end = lines.findIndex((entry, index) => index > at && /^\s*<\/details>\s*$/.test(entry));
      if (end !== -1) {
        const inner = lines.slice(at + 1, end);
        const heading = /^\s*<summary>(.*)<\/summary>\s*$/.exec(inner[0] ?? "");
        blocks.push({
          type: "details",
          summary: heading?.[1] ?? "Details",
          blocks: parseBlocks(heading ? inner.slice(1) : inner),
        });
        at = end + 1;
        continue;
      }
    }

    if (line.trim().startsWith("$$")) {
      const opening = line.trim().slice(2);
      if (opening.endsWith("$$") && opening.length > 2) {
        blocks.push({ type: "math", source: opening.slice(0, -2) });
        at += 1;
        continue;
      }
      const end = lines.findIndex((entry, index) => index > at && entry.trim().endsWith("$$"));
      if (end !== -1) {
        const body = [opening, ...lines.slice(at + 1, end), (lines[end] ?? "").trim().slice(0, -2)];
        blocks.push({ type: "math", source: body.join("\n").trim() });
        at = end + 1;
        continue;
      }
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
      const aligns = columnAligns(lines[at + 1] ?? "");
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && (lines[at] ?? "").includes("|") && (lines[at] ?? "").trim() !== "") {
        rows.push(tableCells(lines[at] ?? ""));
        at += 1;
      }
      blocks.push({ type: "table", head, rows, aligns: resolveAligns(aligns, rows) });
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

/** Off, the source stays as the person would have typed it. */
function InlineMath({ source }: { source: string }) {
  const enabled = useUi((state) => state.mathRendering);
  return enabled ? <Tex source={source} block={false} /> : <>${source}$</>;
}

function MathBlock({ source }: { source: string }) {
  const enabled = useUi((state) => state.mathRendering);
  return enabled ? <Tex source={source} block /> : <p dir="auto">{`$$${source}$$`}</p>;
}

function linkFor(key: string, rawHref: string, label: ReactNode, fallback: string): ReactNode {
  const thread = threadLinkId(rawHref);
  if (thread) return <ThreadLink key={key} id={thread}>{label}</ThreadLink>;
  const href = safeHref(rawHref);
  if (href) return <ExternalLink key={key} href={href}>{label}</ExternalLink>;
  const file = fileLinkTarget(rawHref);
  if (file) return <FileLink key={key} path={file.path} line={file.line}>{label}</FileLink>;
  return fallback;
}

const INLINE =
  /!\[([^\]\n]*)\]\(([^()\s]+)\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\d$])|(`+)([\s\S]*?[^`])\4(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|(?<![\w])_([^\s_](?:[\s\S]*?[^\s_])?)_(?![\w])|~~([\s\S]+?)~~|\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}${index++}`;
    const [whole, imageAlt, imageSrc, math, , code, bold1, bold2, em1, em2, strike, linkText, linkHref, bare] = match;
    if (imageSrc !== undefined) {
      const href = safeHref(imageSrc);
      out.push(href ? <MarkdownImage key={key} src={href} alt={imageAlt ?? ""} /> : whole);
    } else if (math !== undefined) out.push(<InlineMath key={key} source={math} />);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(<strong key={key}>{renderInline(bold1 ?? bold2 ?? "", `${key}-`)}</strong>);
    else if (em1 !== undefined || em2 !== undefined)
      out.push(<em key={key}>{renderInline(em1 ?? em2 ?? "", `${key}-`)}</em>);
    else if (strike !== undefined)
      out.push(<del key={key}>{renderInline(strike, `${key}-`)}</del>);
    else if (linkText !== undefined) {
      out.push(linkFor(key, linkHref ?? "", renderInline(linkText, `${key}-`), whole));
    } else if (bare !== undefined) {
      out.push(linkFor(key, bare, bare, bare));
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

function Details({ block }: { block: Extract<Block, { type: "details" }> }) {
  return (
    <Collapsible
      className="md-details"
      summaryClassName="trace-summary"
      summary={
        <>
          <ChevronRight size={14} className="chev" aria-hidden />
          <span className="trace-label">{renderInline(block.summary)}</span>
        </>
      }
    >
      {block.blocks.map(renderBlock)}
    </Collapsible>
  );
}

const tableText = (block: Extract<Block, { type: "table" }>) =>
  [block.head, ...block.rows].map((row) => block.head.map((_, at) => row[at] ?? "").join("\t")).join("\n");

function Table({ block }: { block: Extract<Block, { type: "table" }> }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(tableText(block)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  const align = (column: number) => block.aligns[column] ?? undefined;
  return (
    <div className="md-table-wrap">
      <div className="md-table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {block.head.map((cell, at) => (
                <th key={at} style={{ textAlign: align(at) }}>{renderInline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, at) => (
              <tr key={at}>
                {block.head.map((_, cell) => (
                  <td key={cell} style={{ textAlign: align(cell) }}>{renderInline(row[cell] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="md-table-actions">
        <IconButton label={copied ? "Copied" : "Copy table"} onClick={copy}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </IconButton>
      </span>
    </div>
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level + 1}` as "h2" | "h3" | "h4" | "h5";
      return <Tag key={key} dir="auto">{renderInline(block.text)}</Tag>;
    }
    case "paragraph":
      return <p key={key} dir="auto">{withBreaks(block.text)}</p>;
    case "code":
      return block.lang === "mermaid" ? (
        <Mermaid key={key} code={block.text} />
      ) : (
        <CodeBlock key={key} code={block.text} lang={block.lang} />
      );
    case "quote":
      return <blockquote key={key} dir="auto">{block.blocks.map(renderBlock)}</blockquote>;
    case "math":
      return <MathBlock key={key} source={block.source} />;
    case "details":
      return <Details key={key} block={block} />;
    case "list": {
      const children = block.items.map((item, at) => <li key={at} dir="auto">{item.map(renderBlock)}</li>);
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {children}
        </ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    }
    case "table":
      return <Table key={key} block={block} />;
    case "rule":
      return <hr key={key} />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text.split(/\r\n|\n|\r/)), [text]);
  return <div className="md">{blocks.map(renderBlock)}</div>;
}
