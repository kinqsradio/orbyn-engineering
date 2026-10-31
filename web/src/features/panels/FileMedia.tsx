import { useEffect, useMemo, useState } from "react";
import { readToken } from "../../api/token";
import { toFailure } from "../../lib/useAsync";
import { Button } from "../../ui/controls";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "font";

const KINDS: [RegExp, MediaKind][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/, "image"],
  [/\.(mp4|m4v|webm|mov|ogv)$/, "video"],
  [/\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)$/, "audio"],
  [/\.pdf$/, "pdf"],
  [/\.(woff2?|ttf|otf)$/, "font"],
];

/** What the service shows inline; it decides from the name, so this does too. */
export function mediaKind(path: string): MediaKind | null {
  const name = path.toLowerCase();
  return KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** Elements can't set a header, so this route takes the token in the query. */
export function rawUrl(threadId: string, path: string, download = false): string {
  const token = readToken();
  const query = new URLSearchParams({ path });
  if (token) query.set("token", token);
  if (download) query.set("download", "true");
  return `/api/threads/${encodeURIComponent(threadId)}/files/raw?${query}`;
}

const CHUNK_BYTES = 64 * 1024;
const ROW_BYTES = 16;
const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog 0123456789";

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0");
const shown = (byte: number) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".");

/** Offset, bytes and printable characters, one row of sixteen. */
export function hexRows(bytes: Uint8Array, start = 0): { offset: string; hex: string; text: string }[] {
  const rows = [];
  for (let at = 0; at < bytes.length; at += ROW_BYTES) {
    const row = [...bytes.subarray(at, at + ROW_BYTES)];
    rows.push({
      offset: (start + at).toString(16).padStart(8, "0"),
      hex: row.map(hexByte).join(" "),
      text: row.map(shown).join(""),
    });
  }
  return rows;
}

function FontSample({ url, path }: { url: string; path: string }) {
  const family = useMemo(() => `orbyn-sample-${path.replace(/\W/g, "-")}`, [path]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const face = new FontFace(family, `url("${url}")`);
    let live = true;
    face.load().then(
      (loaded) => {
        if (live) document.fonts.add(loaded);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [family, url]);
  if (failed) return <p className="muted">This font can't be read.</p>;
  return (
    <div className="file-font" style={{ fontFamily: family }}>
      <p style={{ fontSize: 32 }}>{FONT_SAMPLE}</p>
      <p style={{ fontSize: 20 }}>{FONT_SAMPLE}</p>
      <p style={{ fontSize: 14 }}>{FONT_SAMPLE}</p>
    </div>
  );
}

export function FileMedia({ kind, threadId, path }: { kind: MediaKind; threadId: string; path: string }) {
  const url = rawUrl(threadId, path);
  const name = path.split("/").at(-1) ?? path;
  switch (kind) {
    case "image":
      return (
        <div className="file-media">
          <img src={url} alt={name} />
        </div>
      );
    case "video":
      return (
        <div className="file-media">
          <video src={url} controls aria-label={name} />
        </div>
      );
    case "audio":
      return (
        <div className="file-media">
          <audio src={url} controls aria-label={name} />
        </div>
      );
    case "pdf":
      return <iframe className="file-frame" title={name} src={url} />;
    case "font":
      return <FontSample url={url} path={path} />;
  }
}

/** Reads a binary or an oversized text file a piece at a time, over byte ranges. */
export function FileBytes({ threadId, path, size, as }: { threadId: string; path: string; size: number; as: "hex" | "text" }) {
  const [chunks, setChunks] = useState<Uint8Array[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loaded = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const loadFrom = async (from: number, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(rawUrl(threadId, path), {
        headers: { Range: `bytes=${from}-${from + CHUNK_BYTES - 1}` },
        signal,
      });
      if (!response.ok) throw new Error(`The service answered ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (signal?.aborted) return;
      setChunks((current) => [...current, bytes.subarray(0, CHUNK_BYTES)]);
    } catch (failure) {
      if (signal?.aborted) return;
      setError(`Couldn't read this file. ${toFailure(failure).message}`);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const abort = new AbortController();
    setChunks([]);
    void loadFrom(0, abort.signal);
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, path]);

  // A large file is called text without being read, so its first bytes settle it.
  const hex = as === "hex" || chunks[0]?.includes(0) === true;
  let offset = 0;
  return (
    <div className="file-bytes">
      <p className="muted">
        Showing {loaded.toLocaleString()} of {size.toLocaleString()} bytes
      </p>
      <pre tabIndex={0} className="file-source" aria-label={hex ? "Bytes" : "Text"}>
        {hex
          ? chunks.flatMap((chunk) => {
              const start = offset;
              offset += chunk.length;
              return hexRows(chunk, start).map((row) => (
                <span key={row.offset}>
                  <i>{row.offset}</i>
                  {row.hex.padEnd(ROW_BYTES * 3)} {row.text}
                  {"\n"}
                </span>
              ));
            })
          : new TextDecoder().decode(joinChunks(chunks))}
      </pre>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {loaded < size ? (
        <Button small tone="quiet" disabled={loading} onClick={() => void loadFrom(loaded)}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
}
