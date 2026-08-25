import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * ESLint est reduit au strict minimum : uniquement les regles qui exigent le
 * verificateur de types de TypeScript, que Biome ne sait pas encore fournir.
 *
 * Aucune regle de style, de formatage ou de syntaxe n est activee ici. Biome en
 * a la charge exclusive, et deux outils qui se disputent le meme fichier
 * produisent des allers-retours a chaque enregistrement.
 *
 * Ces regles ne sont pas decoratives : sur ce depot, no-unnecessary-condition a
 * revele qu une borne du manifeste etait statiquement toujours nulle,
 * no-base-to-string une conversion de Request en chaine, et
 * no-unnecessary-type-assertion plusieurs assertions qui masquaient un type
 * deja correct.
 */
export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      ".claude/**",
      "archive*/**",
      "docker/**",
      "**/*.config.ts",
      "eslint.config.ts",
      "vitest.config.ts",
      "commitlint.config.js",
    ],
  },
  tseslint.configs.base,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "no-useless-assignment": "error",
    },
  },
  {
    // Les doublures de test respectent des signatures asynchrones sans jamais
    // avoir besoin d attendre, et manipulent volontairement des valeurs libres.
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
]);
