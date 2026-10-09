import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-win", "src-tauri", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Deliberate in this codebase: best-effort `try { ... } catch {}` and `cond && fn()`.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      // Async event handlers are the norm for IPC-backed UI; floating promises are still an error.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, attributes: false, properties: false } }],
      // Untyped JSON.parse and event payloads leak `any`. Tighten to "error" once those are typed.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },
  {
    files: ["**/*.js", "vite.config.ts", "vitest.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
);
