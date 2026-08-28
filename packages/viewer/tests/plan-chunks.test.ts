import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planChunks } from "../src/rag/plan.js";

const MINUTE = 60 * 1000;
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE channel (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE post (rowid INTEGER PRIMARY KEY, ch INTEGER, usr INTEGER, create_at INTEGER, root INTEGER);
    CREATE TABLE post_text (rowid INTEGER PRIMARY KEY, message TEXT);
    INSERT INTO channel VALUES (1, 'general'), (2, 'autre');
    INSERT INTO user VALUES (1, 'alice'), (2, 'bob');
  `);
});

afterEach(() => {
  db.close();
});

function poster(
  rowid: number,
  over: { ch?: number; usr?: number; at?: number; root?: number | null; message?: string } = {},
): void {
  db.prepare("INSERT INTO post VALUES (?, ?, ?, ?, ?)").run(
    rowid,
    over.ch ?? 1,
    over.usr ?? 1,
    over.at ?? rowid * MINUTE,
    over.root ?? null,
  );
  db.prepare("INSERT INTO post_text VALUES (?, ?)").run(rowid, over.message ?? "un message");
}

describe("planChunks", () => {
  it("ne compte aucun fragment sur un index vide", () => {
    const r = planChunks(db);
    expect(r).toMatchObject({ fragments: 0, threads: 0, windows: 0, tokens: 0 });
  });

  it("compte separement ce qui vient des fils et des fenetres", () => {
    poster(1);
    poster(2, { root: 1 });
    poster(10, { at: 500 * MINUTE });
    const r = planChunks(db);
    expect(r.threads).toBe(1);
    expect(r.windows).toBe(1);
    expect(r.fragments).toBe(2);
  });

  it("ne compte jamais une racine deux fois", () => {
    // Le piege : le parcours est chronologique, donc une racine passe avant ses
    // reponses. La compter en chemin la ferait entrer dans une fenetre en plus
    // de son fil, ce qui gonflait les premieres mesures de ce projet d un quart.
    poster(1);
    poster(2, { root: 1, at: 400 * MINUTE });
    const r = planChunks(db);
    expect(r.fragments).toBe(1);
    expect(r.windows).toBe(0);
  });

  it("attribue chaque fermeture de fenetre a sa cause", () => {
    poster(1, { at: 0 });
    poster(2, { at: 90 * MINUTE });
    poster(3, { at: 91 * MINUTE, ch: 2 });
    const r = planChunks(db);
    expect(r.closedByGap).toBe(1);
    expect(r.closedByChannel).toBe(1);
    expect(r.closedByCap).toBe(0);
  });

  it("montre l effet de la coupure temporelle, ce pour quoi il existe", () => {
    for (let i = 1; i <= 10; i += 1) poster(i, { at: i * 20 * MINUTE });
    const serre = planChunks(db, { gapMs: 10 * MINUTE });
    const large = planChunks(db, { gapMs: 60 * MINUTE });
    expect(serre.fragments).toBeGreaterThan(large.fragments);
  });

  it("nomme le canal et l auteur dans le texte compte", () => {
    poster(1, { usr: 2, message: "bonjour" });
    // Le texte pese sur le budget : un en-tete est du token paye a chaque
    // fragment, et le compte doit donc le refleter.
    const r = planChunks(db);
    expect(r.tokens).toBeGreaterThan(0);
  });

  it("refuse un fichier qui n est pas un index", () => {
    const vide = new DatabaseSync(":memory:");
    try {
      expect(() => planChunks(vide)).toThrow(/index/i);
    } finally {
      vide.close();
    }
  });
});

describe("lectures d index incompletes", () => {
  it("traduit l absence d une table liee, pas seulement de post", () => {
    // Une base qui a post mais pas channel remontait une erreur SQLite brute,
    // sans dire au lecteur quoi faire.
    const ampute = new DatabaseSync(":memory:");
    ampute.exec(`
      CREATE TABLE post (rowid INTEGER PRIMARY KEY, ch INTEGER, usr INTEGER, create_at INTEGER, root INTEGER);
      CREATE TABLE post_text (rowid INTEGER PRIMARY KEY, message TEXT);
    `);
    try {
      expect(() => planChunks(ampute)).toThrow(/mmarchive-index/);
    } finally {
      ampute.close();
    }
  });
});

describe("centiles", () => {
  it("ne fait pas pointer le 90e centile sur le maximum", () => {
    // Dix fragments de tailles tres differentes : si p90 vaut le maximum, le
    // calcul est decale d un cran et la distribution rapportee est fausse.
    for (let i = 1; i <= 9; i += 1) poster(i, { at: i * 500 * MINUTE, message: "court" });
    poster(10, { at: 10 * 500 * MINUTE, message: "x".repeat(2000) });
    const r = planChunks(db);
    expect(r.fragments).toBe(10);
    expect(r.p90).toBeLessThan(r.max);
  });
});
