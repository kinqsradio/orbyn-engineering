import { useMemo } from "react";
import { Markdown } from "../thread/Markdown";
import { Mermaid } from "../thread/Mermaid";

export type PreviewKind = "markdown" | "delimited" | "mermaid" | "html" | "notebook";

export function previewKind(path: string): PreviewKind | null {
  const name = path.toLowerCase();
  if (/\.(md|mdx|markdown)$/.test(name)) return "markdown";
  if (/\.(csv|tsv)$/.test(name)) return "delimited";
  if (/\.(mmd|mermaid)$/.test(name)) return "mermaid";
  if (/\.html?$/.test(name)) return "html";
  if (name.endsWith(".ipynb")) return "notebook";
  return null;
}

const MAX_ROWS = 2000;

/** Quoted fields and doubled quotes, by the delimiter the header line favours. */
export function parseDelimited(text: string): string[][] {
  const first = text.split("\n", 1)[0] ?? "";
  const delimiter = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length > 0) rows.push([...row, field]);
  return rows;
}

function Delimited({ text }: { text: string }) {
  const rows = useMemo(() => parseDelimited(text), [text]);
  const [head, ...body] = rows;
  if (!head) return <p className="muted">This file is empty.</p>;
  return (
    <div className="md-table file-table" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {head.map((cell, at) => (
              <th key={at}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_ROWS).map((row, at) => (
            <tr key={at}>
              {head.map((_, cell) => (
                <td key={cell}>{row[cell] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_ROWS ? <p className="muted">Showing the first {MAX_ROWS} rows.</p> : null}
    </div>
  );
}

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: { text?: string | string[] }[];
}

const joined = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join("") : (value ?? ""));

function Notebook({ text }: { text: string }) {
  const cells = useMemo<NotebookCell[] | null>(() => {
    try {
      const parsed = JSON.parse(text) as { cells?: NotebookCell[] };
      return parsed.cells ?? null;
    } catch {
      return null;
    }
  }, [text]);
  if (!cells) return <p className="muted">This notebook can't be read.</p>;
  return (
    <div className="file-notebook">
      {cells.map((cell, at) =>
        cell.cell_type === "markdown" ? (
          <Markdown key={at} text={joined(cell.source)} />
        ) : (
          <div key={at}>
            <pre tabIndex={0} className="file-source">{joined(cell.source)}</pre>
            {cell.outputs?.map((output, index) =>
              output.text ? <pre key={index} className="tool-output">{joined(output.text)}</pre> : null,
            )}
          </div>
        ),
      )}
    </div>
  );
}

export function FilePreview({ kind, text }: { kind: PreviewKind; text: string }) {
  switch (kind) {
    case "markdown":
      return (
        <div className="file-preview">
          <Markdown text={text} />
        </div>
      );
    case "delimited":
      return <Delimited text={text} />;
    case "mermaid":
      return (
        <div className="file-preview">
          <Mermaid code={text} />
        </div>
      );
    case "html":
      // No scripts and no same-origin access: a checkout's page can't reach the app.
      return <iframe className="file-frame" title="HTML preview" sandbox="" srcDoc={text} />;
    case "notebook":
      return <Notebook text={text} />;
  }
}
