import js from "@eslint/js";
import hooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import path from "node:path";

const sourceRoot = path.join(import.meta.dirname, "src");
const boundaryRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      private: "Import another feature through its public entry point (web/README.md).",
      inward: "Shared folders never import a feature or app (web/README.md).",
    },
  },
  create(context) {
    const importer = path.relative(sourceRoot, context.filename).split(path.sep);
    function check(node) {
      const source = node.source ?? node.argument;
      if (typeof source?.value !== "string" || !source.value.startsWith(".")) return;
      const target = path.relative(sourceRoot, path.resolve(path.dirname(context.filename), source.value))
        .split(path.sep);
      if (["ui", "state", "lib", "api", "styles"].includes(importer[0]) &&
          ["features", "app"].includes(target[0])) {
        context.report({ node: source, messageId: "inward" });
      } else if (importer[0] === "features" && target[0] === "features" &&
          importer[1] !== target[1] &&
          !(target.length === 3 && ["public", "public.ts", "public.tsx"].includes(target[2]))) {
        context.report({ node: source, messageId: "private" });
      }
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      TSImportType: check,
    };
  },
};

const everywhere = [
  { group: ["@tauri-apps/*"], message: "web must not import Tauri." },
  { group: ["**/mock/*", "**/mock"], message: "The mock API is dev-only." },
];

export default tseslint.config(
  { ignores: ["dist", "src/generated", "test-results", "playwright-report"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks, architecture: { rules: { boundaries: boundaryRule } } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "architecture/boundaries": "error",
      "no-restricted-imports": ["error", { patterns: everywhere }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/{ui,state,lib,api,styles}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...everywhere,
            {
              group: ["**/features/**", "**/app/**"],
              message: "Shared folders never import a feature or app. Move the code to its owner (web/README.md).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["mock/**", "e2e/**", "src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/test-support.ts", "vite.config.ts", "playwright.config.ts"],
    rules: { "no-restricted-imports": "off", "architecture/boundaries": "off" },
  },
  {
    files: ["scripts/**"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
