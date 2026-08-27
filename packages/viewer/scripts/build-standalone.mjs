import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Produit un viewer en un seul fichier, ouvrable par double clic.
 *
 * Trois contraintes mesurees sur Chrome commandent cette construction, et
 * expliquent pourquoi le bundle habituel ne suffit pas :
 *
 * 1. Un module ES charge depuis file:// est refuse par la politique d origine
 *    croisee, l origine y etant nulle. La sortie doit donc etre un script
 *    classique, pas un module.
 * 2. Un worker ne peut pas etre charge depuis un fichier voisin, pour la meme
 *    raison. Son code est donc injecte comme chaine et instancie depuis une URL
 *    blob, ce qui reste autorise.
 * 3. Aucune requete n est possible, pas meme vers le fichier d a cote : le
 *    binaire WebAssembly de SQLite est donc inline dans le worker.
 *
 * L index, lui, reste a l exterieur : l utilisateur le designe, et il est lu par
 * tranches sans jamais etre charge en entier.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const webRoot = join(packageRoot, "web");
const outDir = join(webRoot, "dist-standalone");

const require = createRequire(join(packageRoot, "package.json"));
const wasmPath = join(dirname(require.resolve("@sqlite.org/sqlite-wasm")), "sqlite3.wasm");
const wasmBase64 = readFileSync(wasmPath).toString("base64");

/** Reconstitue le binaire dans le worker, sans requete ni dependance. */
const wasmPrelude = `const __MMARCHIVE_WASM__ = (() => {
  const b64 = "${wasmBase64}";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
})();`;

const workerBundle = await build({
  entryPoints: [join(webRoot, "src/lite/worker.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  banner: { js: wasmPrelude },
  define: {
    // Le moteur resout l adresse de son .wasm avant meme de regarder si on lui
    // en a fourni un. En script classique import.meta.url est vide, ce qui fait
    // echouer la construction d URL : cette base ne sert qu a la rendre valide,
    // elle n est jamais suivie puisque le binaire est deja en memoire.
    "import.meta.url": JSON.stringify("https://localhost/"),
  },
  // Le paquet resout son .wasm par une URL : inutile ici, le binaire est deja
  // en memoire et cette resolution ne doit pas ramener de requete.
  loader: { ".wasm": "empty" },
});

const workerSource = workerBundle.outputFiles[0]?.text ?? "";
if (workerSource === "") throw new Error("Bundle du worker vide.");

const mainBundle = await build({
  entryPoints: [join(webRoot, "src/main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  jsx: "automatic",
  define: {
    __MMARCHIVE_WORKER_SOURCE__: JSON.stringify(workerSource),
  },
  // La feuille de style est inseree a part dans le document : l import du
  // bundle ne sert qu a satisfaire le graphe de dependances.
  loader: { ".css": "empty" },
  logOverride: { "empty-import-meta": "silent", "ignored-bare-import": "silent" },
});

const js = mainBundle.outputFiles[0]?.text ?? "";
const css = readFileSync(join(webRoot, "src/ui/styles.css"), "utf8");
if (js === "") throw new Error("Bundle principal vide.");

const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Archive</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="racine"></div>
    <script>${js}</script>
  </body>
</html>
`;

mkdirSync(outDir, { recursive: true });
const target = join(outDir, "archive.html");
writeFileSync(target, html);
process.stdout.write(
  `${target} : ${(Buffer.byteLength(html) / 1048576).toFixed(1)} Mo, dont ${(Buffer.byteLength(wasmBase64) / 1048576).toFixed(1)} Mo de moteur SQLite\n`,
);
