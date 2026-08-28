/**
 * Lecture de l index pour le decoupage.
 *
 * Partage entre la simulation et l ecriture de la reserve : deux facons de lire
 * les memes messages divergeraient, et les chiffres annonces cesseraient de
 * decrire ce qui est reellement ecrit.
 */
import type { DatabaseSync } from "node:sqlite";
import { IndexReadError } from "../query/driver.js";
import type { ChunkContext, ChunkInput } from "./chunk.js";

const COLONNES = `SELECT p.ch, p.rowid AS rowid, p.create_at, p.root, p.usr,
                         coalesce(t.message, '') AS message
                  FROM post p LEFT JOIN post_text t ON t.rowid = p.rowid`;

/**
 * Toute lecture de l index passe par ici. Ne proteger que la premiere laisserait
 * une base amputee d une table remonter une erreur SQLite brute au lieu du
 * message qui dit quoi faire.
 */
export function lisant<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof IndexReadError) throw cause;
    throw new IndexReadError(
      "Index illisible : construisez le avec mmarchive-index avant de decouper l archive.",
      { cause },
    );
  }
}

export function contexteDepuis(db: DatabaseSync): ChunkContext {
  const canaux = new Map<number, string>();
  for (const row of db.prepare("SELECT id, name FROM channel").iterate()) {
    canaux.set(Number(row.id), String(row.name));
  }
  const utilisateurs = new Map<number, string>();
  for (const row of db.prepare("SELECT id, username FROM user").iterate()) {
    utilisateurs.set(Number(row.id), String(row.username));
  }
  return {
    channelName: (ch) => canaux.get(ch) ?? `canal-${String(ch)}`,
    userName: (usr) => (usr === null ? "inconnu" : (utilisateurs.get(usr) ?? `u${String(usr)}`)),
    day: (createAt) => new Date(createAt).toISOString().slice(0, 10),
  };
}

/**
 * Les racines sont connues avant le parcours, jamais decouvertes en chemin.
 *
 * Les decouvrir a la premiere reponse rencontree parait naturel et se paie cher :
 * le parcours etant chronologique, une racine arrive toujours avant ses reponses,
 * et se retrouve comptee a la fois comme fenetre et comme fil. La premiere
 * simulation de ce projet surestimait ainsi le nombre de fragments d un quart.
 */
export function racines(db: DatabaseSync): Set<number> {
  const out = new Set<number>();
  for (const row of db
    .prepare("SELECT DISTINCT root AS r FROM post WHERE root IS NOT NULL")
    .iterate()) {
    out.add(Number(row.r));
  }
  return out;
}

export function* parcourir(db: DatabaseSync, ordre: string): Generator<ChunkInput> {
  for (const row of db.prepare(`${COLONNES} ORDER BY ${ordre}`).iterate()) {
    yield {
      ch: Number(row.ch),
      rowid: Number(row.rowid),
      create_at: Number(row.create_at),
      root: row.root === null ? null : Number(row.root),
      usr: row.usr === null ? null : Number(row.usr),
      message: String(row.message),
    };
  }
}

export function* seulementFils(
  source: Iterable<ChunkInput>,
  connues: ReadonlySet<number>,
): Generator<ChunkInput> {
  for (const m of source) if (m.root !== null || connues.has(m.rowid)) yield m;
}

export function* seulementIsoles(
  source: Iterable<ChunkInput>,
  connues: ReadonlySet<number>,
): Generator<ChunkInput> {
  for (const m of source) if (m.root === null && !connues.has(m.rowid)) yield m;
}

/** Ordres de parcours attendus par chaque decoupage. */
export const ORDRE_FILS = "coalesce(p.root, p.rowid), p.create_at, p.rowid";
export const ORDRE_CANAUX = "p.ch, p.create_at, p.rowid";
