import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/cli.ts", "src/redact.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // tsup 8 retire le prefixe node: par defaut, un heritage des runtimes qui ne
  // le comprenaient pas. node:fs survit grace a son alias historique, mais
  // node:sqlite n en a aucun : le binaire construit cherchait alors un paquet
  // npm nomme "sqlite" et ne demarrait pas.
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
  // Le CLI est distribue en bundle : shared est inline, aucune resolution
  // workspace n est necessaire a l execution.
  noExternal: ["@mmarchive/shared"],
  define: { __MMARCHIVE_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node" },
});
