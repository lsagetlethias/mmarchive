import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEXICAL_DEFAULT_LIMIT,
  pruneCommonWords,
  questionToMatch,
  searchLexical,
} from "../src/rag/lexical.js";
import { STORE_DDL, STORE_FTS, STORE_INDEXES } from "../src/rag/store-schema.js";

let workDir: string;
let store: DatabaseSync;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-lexical-"));
  store = new DatabaseSync(join(workDir, "vectors.db"));
  store.exec(STORE_DDL);
  store.exec(STORE_INDEXES);
});

afterEach(async () => {
  store.close();
  await rm(workDir, { recursive: true, force: true });
});

let suivant = 0;
function fragment(text: string, ch = 1): number {
  suivant += 1;
  store
    .prepare(
      `INSERT INTO fragment (rowid, ch, root, first_id, last_id, first_at, last_at, part, messages, text)
       VALUES (?, ?, NULL, ?, ?, 0, 0, 0, 1, ?)`,
    )
    .run(suivant, ch, suivant, suivant, text);
  return suivant;
}

function indexer(): void {
  store.exec(STORE_FTS);
}

describe("questionToMatch", () => {
  it("relie les mots par OU, pas par ET", () => {
    // Une question de dix mots dont chacun devrait apparaitre ne trouverait
    // rien. C est au classement de trier, pas au filtre.
    expect(questionToMatch("qui a decide")).toBe('"qui" OR "decide"');
  });

  it("ecarte les mots d une seule lettre", () => {
    expect(questionToMatch("a b oui")).toBe('"oui"');
  });

  it("ne repete pas un mot present deux fois", () => {
    expect(questionToMatch("format du format")).toBe('"format" OR "du"');
  });

  it("neutralise les operateurs de FTS5", () => {
    // Sans guillemets, ces mots changeraient le sens de la requete au lieu
    // d etre cherches.
    expect(questionToMatch("archive OR NOT NEAR")).toBe('"archive" OR "or" OR "not" OR "near"');
  });

  it("survit aux caracteres qui feraient echouer la requete", () => {
    const match = questionToMatch('parenthese ( et "guillemet"');
    expect(() => store.prepare("SELECT ?").get(match)).not.toThrow();
    expect(match).toContain('"parenthese"');
  });

  it("rend une expression vide quand rien n est exploitable", () => {
    expect(questionToMatch("!!! ? a")).toBe("");
    expect(questionToMatch("")).toBe("");
  });
});

describe("searchLexical", () => {
  it("classe par pertinence et non par ordre d insertion", () => {
    fragment("un texte qui ne parle de rien du tout");
    const cible = fragment("le format d archive et le format des fragments");
    fragment("encore autre chose");
    indexer();
    const hits = searchLexical(store, "format d archive");
    expect(hits[0]?.fragment).toBe(cible);
  });

  it("rend un score d autant plus grand que le fragment repond mieux", () => {
    // SQLite rend un bm25 negatif ou le meilleur est le plus bas. Le signe est
    // inverse ici pour que la fusion combine deux echelles de meme sens.
    fragment("archive");
    fragment("archive archive archive archive");
    indexer();
    const hits = searchLexical(store, "archive");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("ignore les accents, comme la recherche du viewer", () => {
    const cible = fragment("la decision a ete prise");
    indexer();
    expect(searchLexical(store, "décision")[0]?.fragment).toBe(cible);
  });

  it("trouve un mot rare, ce que le vectoriel raterait", () => {
    // C est la raison d etre de cette moitie : un acronyme maison n a pas de
    // voisin semantique.
    fragment("discussion generale sur le projet");
    const cible = fragment("le ticket MMA-4271 est resolu");
    indexer();
    expect(searchLexical(store, "MMA-4271")[0]?.fragment).toBe(cible);
  });

  it("restreint aux canaux demandes", () => {
    fragment("le format d archive", 1);
    const cible = fragment("le format d archive", 2);
    indexer();
    const hits = searchLexical(store, "format", { channels: [2] });
    expect(hits.map((h) => h.fragment)).toEqual([cible]);
  });

  it("respecte la limite demandee", () => {
    for (let i = 0; i < 5; i += 1) fragment("archive commune");
    indexer();
    expect(searchLexical(store, "archive", { limit: 3 })).toHaveLength(3);
  });

  it("s arrete par defaut a une cinquantaine de candidats", () => {
    for (let i = 0; i < LEXICAL_DEFAULT_LIMIT + 10; i += 1) fragment("archive commune");
    indexer();
    expect(searchLexical(store, "archive")).toHaveLength(LEXICAL_DEFAULT_LIMIT);
  });

  it("rend une liste vide sur une question sans mot, plutot qu une erreur", () => {
    fragment("quelque chose");
    indexer();
    // La moitie vectorielle peut tres bien repondre seule : ce n est pas une
    // panne, c est un resultat.
    expect(searchLexical(store, "?!")).toEqual([]);
  });

  it("rend une liste vide quand rien ne correspond", () => {
    fragment("quelque chose");
    indexer();
    expect(searchLexical(store, "introuvable")).toEqual([]);
  });
});

describe("mots trop repandus", () => {
  it("ecarte ceux qui figurent dans une grande part du corpus", () => {
    // « courant » est partout, « rare » nulle part ailleurs : le premier ne
    // discrimine rien et fait scorer tout le corpus pour rien.
    for (let i = 0; i < 20; i += 1) fragment("courant remplissage");
    fragment("courant rare");
    indexer();
    expect(pruneCommonWords(store, ["courant", "rare"])).toEqual(["rare"]);
  });

  it("garde tout quand aucun mot ne discrimine, plutot que de ne rien chercher", () => {
    for (let i = 0; i < 20; i += 1) fragment("courant partout");
    indexer();
    expect(pruneCommonWords(store, ["courant", "partout"]).sort()).toEqual(["courant", "partout"]);
  });

  it("ne touche pas a un mot unique", () => {
    for (let i = 0; i < 20; i += 1) fragment("courant");
    indexer();
    expect(pruneCommonWords(store, ["courant"])).toEqual(["courant"]);
  });

  it("ne change pas le premier resultat", () => {
    for (let i = 0; i < 20; i += 1) fragment("le sujet courant du jour");
    const cible = fragment("le sujet courant du jour et le format d archive");
    indexer();
    // bm25 annulait deja ces mots par leur frequence : les ecarter accelere
    // sans deplacer le classement.
    expect(searchLexical(store, "le sujet courant format")[0]?.fragment).toBe(cible);
  });

  it("cherche quand meme si les statistiques de vocabulaire manquent", () => {
    // Sans elles la recherche est plus lente, ce qui n est pas une raison de
    // refuser de repondre.
    const sansFts = new DatabaseSync(":memory:");
    sansFts.exec(STORE_DDL);
    try {
      expect(pruneCommonWords(sansFts, ["un", "deux"])).toEqual(["un", "deux"]);
    } finally {
      sansFts.close();
    }
  });
});
