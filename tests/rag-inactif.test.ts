import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLitePackage } from "../packages/viewer/src/server/lite-package.js";

/**
 * Le RAG est optionnel par construction : l outil doit rester pleinement
 * fonctionnel sans lui.
 *
 * « Optionnel » ne veut pas dire « desactivable » mais « absent tant qu on ne le
 * demande pas ». Ces controles portent donc sur les dependances plutot que sur
 * un drapeau : un import suffit a faire entrer le RAG dans le serveur, et
 * personne ne s en apercevrait avant que le mode sans serveur grossisse ou qu une
 * route apparaisse.
 */
const RACINE = fileURLToPath(new URL("..", import.meta.url));
const VIEWER = join(RACINE, "packages", "viewer");

function sources(depuis: string): string[] {
  const trouves: string[] = [];
  for (const entree of readdirSync(depuis)) {
    const chemin = join(depuis, entree);
    if (statSync(chemin).isDirectory()) {
      if (entree === "node_modules" || entree === "dist") continue;
      trouves.push(...sources(chemin));
    } else if (entree.endsWith(".ts") || entree.endsWith(".tsx")) {
      trouves.push(chemin);
    }
  }
  return trouves;
}

/**
 * Toutes les facons d atteindre un module, pas seulement l import statique.
 *
 * Ne chercher que `from "…"` laisserait passer un import pour effet de bord, un
 * import dynamique, un `require`, une reexportation, et les guillemets simples.
 * Un garde-fou contournable par une apostrophe ne garde rien.
 */
const CHEMIN_RAG = String.raw`['"][^'"]*\/rag\/[^'"]+['"]`;
const ATTEINTES = [
  new RegExp(String.raw`from\s+${CHEMIN_RAG}`),
  new RegExp(String.raw`import\s+${CHEMIN_RAG}`),
  new RegExp(String.raw`import\s*\(\s*${CHEMIN_RAG}`),
  new RegExp(String.raw`require\s*\(\s*${CHEMIN_RAG}`),
];

function atteintLeRag(source: string): boolean {
  return ATTEINTES.some((motif) => motif.test(source));
}

/** Fichiers qui atteignent le repertoire rag, chemins normalises et tries. */
function dependantsDuRag(racine: string): string[] {
  return sources(racine)
    .filter((fichier) => atteintLeRag(readFileSync(fichier, "utf8")))
    .map((fichier) => fichier.slice(RACINE.length).split(sep).join("/"))
    .sort();
}

describe("le RAG reste hors du chemin ordinaire", () => {
  it("n est atteint par aucun code du serveur", () => {
    // Un seul import ferait entrer le decoupage, le schema de la reserve et la
    // recherche lexicale dans le binaire que le deploiement execute.
    expect(dependantsDuRag(join(VIEWER, "src", "server"))).toEqual([]);
    expect(dependantsDuRag(join(VIEWER, "src", "query"))).toEqual([]);
  });

  it("n est atteint par aucun code du frontend", () => {
    // Le mode sans serveur tourne dans un navigateur qui ne peut ni joindre un
    // fournisseur d embeddings ni tenir une cle : le RAG n y aura jamais sa
    // place, et rien ne doit l y entrainer.
    expect(dependantsDuRag(join(VIEWER, "web", "src"))).toEqual([]);
  });

  it("n est appele que par la commande qui construit l index", () => {
    // Les commandes existent, mais elles ne partent que si quelqu un les lance.
    expect(dependantsDuRag(join(VIEWER, "src"))).toEqual(["packages/viewer/src/cli.ts"]);
  });

  it("repere toutes les facons d atteindre un module", () => {
    // Le garde-fou lui meme se verifie : une apostrophe ou un import dynamique
    // suffiraient sinon a le contourner sans que rien ne le signale.
    for (const forme of [
      'import { fuse } from "../rag/fusion.js";',
      "import { fuse } from '../rag/fusion.js';",
      'import "../rag/fusion.js";',
      'const { fuse } = await import("../rag/fusion.js");',
      'const { fuse } = require("../rag/fusion.js");',
      'export { fuse } from "../rag/fusion.js";',
      'export * from "../rag/fusion.js";',
    ]) {
      expect(atteintLeRag(forme), forme).toBe(true);
    }
    expect(atteintLeRag('import { x } from "./ragoût.js";')).toBe(false);
    expect(atteintLeRag('const rag = "un mot dans une chaine";')).toBe(false);
  });
});

describe("la copie autonome n emporte que ce qu elle annonce", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mmarchive-lite-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("ignore une reserve de fragments posee a cote de l index", async () => {
    // Le cas realiste : vectors.db vit dans le meme repertoire que index.db.
    // L emporter ferait passer la copie de 325 Mo a pres du gigaoctet, pour un
    // navigateur incapable de s en servir.
    const web = join(workDir, "web");
    mkdirSync(web);
    writeFileSync(join(workDir, "index.db"), "index");
    writeFileSync(join(workDir, "vectors.db"), "fragments");
    writeFileSync(join(workDir, "archive.html"), "viewer");
    writeFileSync(join(web, "index.html"), "page");

    const plan = await planLitePackage({
      indexPath: join(workDir, "index.db"),
      standalonePath: join(workDir, "archive.html"),
      webRoot: web,
    });

    const cibles = plan.entries.map((e) => e.target).sort();
    expect(cibles).toEqual(["archive.html", "index.db", "web/index.html"]);
    expect(cibles.some((c) => c.includes("vectors"))).toBe(false);
  });
});

describe("le binaire du serveur", () => {
  const bundle = join(VIEWER, "dist", "serve.js");

  it("ne contient aucun symbole du RAG", (ctx) => {
    // Le build tourne apres les tests dans pnpm verify : sans artefact, ce
    // controle n a rien a lire, et un test qui passerait faute de fichier
    // vaudrait moins que pas de test du tout.
    if (!existsSync(bundle)) ctx.skip();
    const code = readFileSync(bundle, "utf8");
    const fuites = [
      "chunkThreads",
      "chunkWindows",
      "searchLexical",
      "pruneCommonWords",
      "indexFingerprint",
      "fragment_fts",
      "STORE_DDL",
    ].filter((symbole) => code.includes(symbole));
    expect(fuites, "ces symboles du RAG sont entres dans le binaire servi").toEqual([]);
  });
});
