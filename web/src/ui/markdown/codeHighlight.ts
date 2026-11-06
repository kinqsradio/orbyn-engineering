import type { HighlighterCore } from "shiki/core";

export interface Token {
  content: string;
  color?: string;
}

const LANGUAGES: Record<string, () => Promise<unknown>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

export const languageId = (lang: string): string | null => {
  const id = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return id in LANGUAGES ? id : null;
};

/** Token colours resolve through CSS variables, so both themes share one grammar pass. */
const THEME = {
  name: "orbyn",
  type: "dark" as const,
  fg: "var(--code-text)",
  bg: "transparent",
  settings: [
    { settings: { foreground: "var(--code-text)" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--code-comment)" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "var(--code-string)" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "var(--code-number)" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: "var(--code-keyword)" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--code-function)" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "var(--code-type)" } },
    { scope: ["variable.parameter", "variable.other.property"], settings: { foreground: "var(--code-variable)" } },
  ],
};

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

const getHighlighter = () => {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() }),
  );
  return highlighter;
};

/** Lines of coloured tokens, or null for a language without a grammar here. */
export async function highlight(code: string, lang: string): Promise<Token[][] | null> {
  const id = languageId(lang);
  const load = id ? LANGUAGES[id] : undefined;
  if (!id || !load) return null;
  const core = await getHighlighter();
  if (!loaded.has(id)) {
    const grammar = (await load()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
    await core.loadLanguage(grammar.default);
    loaded.add(id);
  }
  return core.codeToTokensBase(code, { lang: id as never, theme: "orbyn" });
}
