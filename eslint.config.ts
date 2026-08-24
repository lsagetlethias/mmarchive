import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      ".claude/**",
      "archive/**",
      "docker/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Le CLI ecrit sur stdout, c est sa raison d etre.
    files: ["packages/extractor/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts", "vitest.config.ts", "eslint.config.ts"],
    rules: {
      "no-console": "off",
      // Les doublures de test (fetch, sleep, executor) doivent respecter une
      // signature asynchrone sans jamais avoir besoin d attendre quoi que ce soit.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  prettier,
]);
