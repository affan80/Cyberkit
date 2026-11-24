import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS fixtures (fake plugins and binaries) run under Node.
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", setInterval: "readonly", setTimeout: "readonly" } },
  },
);
