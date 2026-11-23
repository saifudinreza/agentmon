import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "docs/**", "packages/web/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
