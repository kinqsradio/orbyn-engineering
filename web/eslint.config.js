import js from "@eslint/js";
import hooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src/generated", "test-results", "playwright-report"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@tauri-apps/*"], message: "web must not import Tauri." },
            { group: ["**/mock/*", "**/mock"], message: "The mock API is dev-only." },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["mock/**", "e2e/**", "src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/test-support.ts", "vite.config.ts", "playwright.config.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["scripts/**"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
