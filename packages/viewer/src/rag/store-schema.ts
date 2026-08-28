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
 * Empreinte de ce dont depend le contenu des fragments.
 *
 * Deux choses peuvent perimer une reserve, et il a fallu les deux pour que ce
 * controle serve a quelque chose.
 *
 * La numerotation d abord. Les fragments designent les messages par leur rowid,
 * calcule par `ROW_NUMBER() OVER (ORDER BY create_at, pid)` : un message ajoute
 * ou efface decale tout ce qui le suit, et chaque fragment se met a designer un
 * autre message. L echec est muet, le RAG citerait des propos que personne n a
 * tenus.
 *
 * Les noms ensuite, et c est le cas que la premiere version manquait. Un
 * `mmarchive-redact --mode pseudonymize` laisse les messages en place, donc la
 * suite des identifiants intacte, mais remplace les identites. Une reserve
 * construite avant porterait encore les anciens noms dans le texte de ses
 * fragments : le RAG restituerait exactement ce qu on avait demande d effacer.
 *
 * Le contenu enfin. Un message edite garde son identifiant et sa place : une
 * reextraction rapporte le nouveau texte sans que rien d autre ne bouge. Sans
 * les messages dans l empreinte, la reserve continuerait de servir la version
 * d avant, et l archive et le RAG raconteraient deux choses differentes.
 *
 * Le tout coute environ deux secondes et demie sur plus d un million de
 * messages, paye une fois a l ouverture. C est peu au regard de ce que couterait
 * de servir des fragments perimes sans le savoir.
 */
export function indexFingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT pid FROM post ORDER BY rowid").iterate()) {
    hash.update(String(row.pid));
    hash.update("\u0000");
  }
  hash.update("\u0001utilisateurs");
  for (const row of db.prepare("SELECT id, username FROM user ORDER BY id").iterate()) {
    hash.update(`${String(row.id)}:${String(row.username)}\u0000`);
  }
  hash.update("\u0001canaux");
  for (const row of db.prepare("SELECT id, name FROM channel ORDER BY id").iterate()) {
    hash.update(`${String(row.id)}:${String(row.name)}\u0000`);
  }
  hash.update("\u0001messages");
  for (const row of db.prepare("SELECT rowid, message FROM post_text ORDER BY rowid").iterate()) {
    hash.update(`${String(row.rowid)}:${String(row.message)}\u0000`);
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
