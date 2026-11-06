import { useEffect, useState } from "react";

type Render = (source: string, options: { displayMode: boolean; throwOnError: boolean; trust: boolean }) => string;
let typesetter: Render | null = null;

/** KaTeX loads with the first formula, so threads without math don't pay for it. */
export function Tex({ source, block }: { source: string; block: boolean }) {
  const [render, setRender] = useState<Render | null>(() => typesetter);
  useEffect(() => {
    if (render) return;
    let current = true;
    void Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([katex]) => {
      typesetter = katex.default.renderToString;
      if (current) setRender(() => typesetter);
    });
    return () => {
      current = false;
    };
  }, [render]);
  if (!render) return <code>{source}</code>;
  const html = render(source, { displayMode: block, throwOnError: false, trust: false });
  const Tag = block ? "div" : "span";
  return <Tag className={block ? "md-math" : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}
