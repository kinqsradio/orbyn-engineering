import { useEffect, useId, useState } from "react";
import { useUi } from "../../state/ui";
import { CodeBlock } from "./CodeBlock";

const dark = (theme: string) =>
  theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

/** Draws a diagram; while it's incomplete or invalid, the source stands in. */
export function Mermaid({ code }: { code: string }) {
  const theme = useUi((state) => state.theme);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [drawn, setDrawn] = useState<{ code: string; svg: string } | null>(null);
  useEffect(() => {
    let current = true;
    // Settles after streaming; a broken diagram simply keeps its source showing.
    const timer = setTimeout(() => {
      void import("mermaid")
        .then(async ({ default: mermaid }) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: dark(theme) ? "dark" : "neutral",
          });
          const { svg } = await mermaid.render(`mermaid${id}`, code);
          if (current) setDrawn({ code, svg });
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code, id, theme]);
  if (drawn?.code !== code) return <CodeBlock code={code} lang="mermaid" />;
  return <div className="md-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
}
