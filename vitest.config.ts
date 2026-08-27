import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Les sous-chemins passent avant le barrel : @mmarchive/shared/ndjson touche
    // node:fs et n a donc rien a faire dans l entree que le frontend importera.
    alias: [
      {
        find: /^@mmarchive\/shared\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/$1.ts", import.meta.url)),
      },
      {
        find: "@mmarchive/shared",
        replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
