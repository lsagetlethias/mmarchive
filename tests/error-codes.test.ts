import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, ERROR_CODES, isErrorCode } from "@mmarchive/shared";
import { describe, expect, it } from "vitest";

const RACINE = fileURLToPath(new URL("../packages", import.meta.url));

function sourcesTypeScript(depuis: string): string[] {
  const trouves: string[] = [];
  for (const entree of readdirSync(depuis)) {
    const chemin = join(depuis, entree);
    if (statSync(chemin).isDirectory()) {
      if (entree === "node_modules" || entree === "dist") continue;
      trouves.push(...sourcesTypeScript(chemin));
    } else if (entree.endsWith(".ts") && !entree.endsWith(".test.ts")) {
      trouves.push(chemin);
    }
  }
  return trouves;
}

/**
 * Classes d erreur declarees dans le code, associees au corps de leur classe.
 *
 * L inventaire est lu dans les sources plutot qu obtenu en important les
 * modules : une classe oubliee n est exportee par aucun barrel, et c est
 * precisement celle qu il faut attraper.
 */
function classesDErreur(): { nom: string; fichier: string; corps: string }[] {
  const trouvees: { nom: string; fichier: string; corps: string }[] = [];
  for (const fichier of sourcesTypeScript(join(RACINE, "shared", "src")).concat(
    sourcesTypeScript(join(RACINE, "extractor", "src")),
    sourcesTypeScript(join(RACINE, "viewer", "src")),
  )) {
    const source = readFileSync(fichier, "utf8");
    const motif = /export class (\w*Error) extends \w+ \{/g;
    let trouve: RegExpExecArray | null = motif.exec(source);
    while (trouve !== null) {
      const nom = trouve[1] ?? "";
      const depuis = trouve.index + trouve[0].length;
      const fin = source.indexOf("\nexport ", depuis);
      trouvees.push({
        nom,
        fichier,
        corps: source.slice(depuis, fin === -1 ? undefined : fin),
      });
      trouve = motif.exec(source);
    }
  }
  return trouvees;
}

describe("registre des codes d erreur", () => {
  it("n attribue jamais deux fois le meme code", () => {
    const vus = new Map<string, string>();
    for (const [nom, code] of Object.entries(ERROR_CODES)) {
      expect(vus.get(code), `${code} est deja pris par ${vus.get(code) ?? ""}`).toBeUndefined();
      vus.set(code, nom);
    }
  });

  it("emploie une numerotation reconnaissable", () => {
    for (const code of Object.values(ERROR_CODES)) expect(code).toMatch(/^E[1-5]\d{3}$/);
  });

  it("couvre toutes les classes d erreur du code", () => {
    const sansCode = classesDErreur()
      .filter(({ nom, corps }) => !corps.includes(`ERROR_CODES.${nom};`))
      .map(({ nom, fichier }) => `${nom} (${fichier})`);
    expect(sansCode, "ces classes n exposent pas leur code du registre").toEqual([]);
  });

  it("ne conserve aucune entree devenue orpheline", () => {
    const declarees = new Set(classesDErreur().map(({ nom }) => nom));
    const orphelines = Object.keys(ERROR_CODES).filter((nom) => !declarees.has(nom));
    expect(orphelines, "ces entrees ne correspondent plus a aucune classe").toEqual([]);
  });
});

/**
 * Points d entree livres, deduits des binaires declares plutot que listes a la
 * main : un binaire ajoute sans code d erreur visible est justement celui qu on
 * oublierait dans une liste ecrite ici.
 */
function pointsDEntree(): { paquet: string; binaire: string; source: string }[] {
  const trouves: { paquet: string; binaire: string; source: string }[] = [];
  for (const paquet of ["extractor", "viewer"]) {
    const manifeste = JSON.parse(readFileSync(join(RACINE, paquet, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    for (const [binaire, chemin] of Object.entries(manifeste.bin ?? {})) {
      const source = join(RACINE, paquet, "src", `${basename(chemin, ".js")}.ts`);
      trouves.push({ paquet, binaire, source });
    }
  }
  return trouves;
}

describe("points d entree", () => {
  it("en declarent au moins un par paquet livrable", () => {
    // Par paquet et non au total : un paquet qui perdrait tous ses binaires
    // passerait inapercu derriere le compte d un autre.
    const parPaquet = new Map<string, number>([
      ["extractor", 0],
      ["viewer", 0],
    ]);
    for (const { paquet } of pointsDEntree()) {
      parPaquet.set(paquet, (parPaquet.get(paquet) ?? 0) + 1);
    }
    const sansBinaire = [...parPaquet].filter(([, n]) => n === 0).map(([nom]) => nom);
    expect(sansBinaire, "ces paquets ne declarent plus aucun binaire").toEqual([]);
  });

  it("affichent tous le code de l erreur qui les arrete", () => {
    const muets = pointsDEntree()
      // L appel, pas l import : un describeError importe puis inutilise
      // laisserait passer exactement l oubli que ce test doit attraper.
      .filter(({ source }) => !readFileSync(source, "utf8").includes("describeError("))
      .map(({ binaire, source }) => `${binaire} (${source})`);
    // Un binaire qui rend un message sans son code laisse l utilisateur sans
    // rien a chercher, et la table des codes ne sert plus a rien pour lui.
    expect(muets, "ces binaires rendent une erreur sans son code").toEqual([]);
  });
});

describe("describeError", () => {
  it("prefixe le message du code de l erreur", () => {
    class Bidon extends Error {
      readonly code = ERROR_CODES.OptionsError;
    }
    expect(describeError(new Bidon("chemin absent"))).toBe("[E1001] chemin absent");
  });

  it("laisse intact un message sans code du registre", () => {
    expect(describeError(new Error("panne"))).toBe("panne");
  });

  it("ignore les codes que Node pose sur ses propres erreurs", () => {
    const systeme = Object.assign(new Error("fichier introuvable"), { code: "ENOENT" });
    expect(describeError(systeme)).toBe("fichier introuvable");
    expect(isErrorCode("ENOENT")).toBe(false);
  });

  it("rend lisible ce qui n est pas une erreur", () => {
    expect(describeError("juste une chaine")).toBe("juste une chaine");
  });
});
