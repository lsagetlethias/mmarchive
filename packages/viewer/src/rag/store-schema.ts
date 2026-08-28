/**
 * Schema du fichier de fragments, distinct de l index de consultation.
 *
 * Il vit a part pour une raison mesuree : la copie autonome pese 325 Mo et
 * s ouvre dans un navigateur qui ne peut ni joindre un fournisseur d embeddings
 * ni faire tourner un modele. Loger les fragments et leurs vecteurs dans l index
 * y ferait entrer des centaines de megaoctets de poids mort. Voir
 * docs/DECISION-RAG.md.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const STORE_TABLES = ["meta", "fragment", "fragment_user"] as const;

/** Ce qui manque a un fichier pour servir de reserve de fragments. */
export function missingStoreTables(present: Iterable<string>): string[] {
  const found = new Set(present);
  return STORE_TABLES.filter((table) => !found.has(table));
}

export const STORE_DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Les bornes sont des rowid de post, pas des identifiants Mattermost : c est ce
-- qui permet de remonter au fil complet par une simple plage, sans jointure sur
-- une chaine de 26 caracteres repetee des centaines de milliers de fois.
CREATE TABLE fragment (
  rowid    INTEGER PRIMARY KEY,
  ch       INTEGER NOT NULL,
  root     INTEGER,
  first_id INTEGER NOT NULL,
  last_id  INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  part     INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  text     TEXT NOT NULL
);

CREATE TABLE fragment_user (
  fragment INTEGER NOT NULL,
  usr      INTEGER NOT NULL
);
`;

export const STORE_INDEXES = `
CREATE INDEX fragment_channel ON fragment(ch, first_at);
CREATE INDEX fragment_root ON fragment(root) WHERE root IS NOT NULL;
CREATE INDEX fragment_span ON fragment(first_id, last_id);
CREATE INDEX fragment_user_usr ON fragment_user(usr, fragment);
`;

/**
 * Empreinte de la numerotation de l index.
 *
 * Les fragments designent les messages par leur rowid, et cette numerotation
 * n est stable que tant que l archive ne bouge pas : elle est calculee par
 * `ROW_NUMBER() OVER (ORDER BY create_at, pid)`, donc un message ajoute ou
 * efface decale tout ce qui le suit. Reconstruire l index apres une extraction
 * incrementale ou un `mmarchive-redact` rendrait chaque fragment faux sans que
 * rien ne le signale : le RAG citerait des messages qu il n a pas lus.
 *
 * L empreinte porte sur la suite des identifiants dans l ordre des rowid, ce qui
 * est exactement ce dont depend cette correspondance. Elle coute moins d une
 * seconde sur plus d un million de messages, trop peu pour s en passer.
 */
export function indexFingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT pid FROM post ORDER BY rowid").iterate()) {
    hash.update(String(row.pid));
  }
  return hash.digest("hex");
}

export interface StoreMeta {
  /** Empreinte de l index qui a produit ces fragments. */
  readonly indexFingerprint: string;
  readonly builtAt: string;
  /** Reglages du decoupage, pour savoir ce qui a produit ces fragments. */
  readonly gapMs: number;
  readonly maxMessages: number;
  readonly maxChars: number;
}

export function readStoreMeta(db: DatabaseSync): Partial<StoreMeta> {
  const out: Record<string, string> = {};
  for (const row of db.prepare("SELECT key, value FROM meta").iterate()) {
    out[String(row.key)] = String(row.value);
  }
  const nombre = (v: string | undefined): number => (v === undefined ? 0 : Number(v));
  return {
    ...(out.index_fingerprint === undefined ? {} : { indexFingerprint: out.index_fingerprint }),
    ...(out.built_at === undefined ? {} : { builtAt: out.built_at }),
    gapMs: nombre(out.gap_ms),
    maxMessages: nombre(out.max_messages),
    maxChars: nombre(out.max_chars),
  };
}

export function writeStoreMeta(db: DatabaseSync, meta: StoreMeta): void {
  const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  insert.run("index_fingerprint", meta.indexFingerprint);
  insert.run("built_at", meta.builtAt);
  insert.run("gap_ms", String(meta.gapMs));
  insert.run("max_messages", String(meta.maxMessages));
  insert.run("max_chars", String(meta.maxChars));
}
