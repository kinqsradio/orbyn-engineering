import { Check, Copy, WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../ui/controls";
import { highlight, type Token } from "./codeHighlight";

/** `bare` drops the header, for a command shown above its output. */
export function CodeBlock({ code, lang, bare = false }: { code: string; lang: string; bare?: boolean }) {
  const [tokens, setTokens] = useState<{ code: string; lines: Token[][] } | null>(null);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!lang) return;
    let current = true;
    // Streaming re-renders settle quickly; a failed grammar just stays plain.
    const timer = setTimeout(() => {
      highlight(code, lang).then(
        (lines) => {
          if (current && lines) setTokens({ code, lines });
        },
        () => undefined,
      );
    }, 80);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code, lang]);

  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  const lines = tokens?.code === code ? tokens.lines : null;
  return (
    <div className="code-card" data-wrap={wrap || undefined}>
      {bare ? null : <div className="code-head">
        <span className="code-lang">{lang}</span>
        <span className="code-actions">
          <IconButton label={wrap ? "Disable line wrap" : "Enable line wrap"} pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText size={14} aria-hidden />
          </IconButton>
          <IconButton label={copied ? "Copied" : "Copy code"} onClick={copy}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </IconButton>
        </span>
      </div>}
      <pre tabIndex={0} data-lang={lang || undefined}>
        {lines ? (
          <code>
            {lines.map((line, at) => (
              <span key={at}>
                {line.map((token, part) => (
                  <span key={part} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
                {at < lines.length - 1 ? "\n" : null}
              </span>
            ))}
          </code>
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
