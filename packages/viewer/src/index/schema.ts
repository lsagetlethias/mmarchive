/**
 * Version du schema d index. Sans rapport avec SCHEMA_VERSION, qui versionne le
 * format d archive : l archive est la donnee durable, l index est un derive
 * jetable que l on reconstruit en moins d une minute. Incrementer ici oblige
 * seulement a relancer le builder, jamais a toucher a l archive.
 */
export const INDEX_SCHEMA_VERSION = 1;

/** Bits du champ post.flags. Un entier plutot que six colonnes a 1,3 million de lignes. */
export const POST_FLAGS = {
  EDITED: 1,
  PINNED: 2,
  HAS_FILES: 4,
  HAS_REACTIONS: 8,
  DELETED: 16,
  /**
   * Reponse dont la racine ne figure pas dans l index : hors de la fenetre
   * extraite, ou portee par un message que l index ne contient pas. Sans ce bit,
   * root a NULL ne distingue plus une racine d une reponse deracinee, et le
   * viewer afficherait comme un message ordinaire ce qui est en fait la suite
   * d une conversation absente.
   */
  ORPHAN_ROOT: 32,
} as const;

/**
 * Prefixes des termes de filtre de la colonne search.tag.
 *
 * Encoder le canal et l auteur comme des termes indexes plutot que comme des
 * colonnes a joindre laisse FTS5 intersecter deux listes d occurrences au lieu
 * de verifier chaque resultat ligne a ligne. Mesure sur l archive reelle :
 * une recherche restreinte a un canal tombe de 5 781 pages lues a 91.
 */
export const TAG_PREFIX = {
  CHANNEL: "c",
  USER: "u",
  HASHTAG: "h",
} as const;

/**
 * Un hashtag devient un terme unique : le tokenizer unicode61 coupe sur le tiret
 * et sur l underscore, si bien que "#note-de-cadrage" donnerait trois
 * termes dont deux se confondraient avec des mots ordinaires du corpus. On ne
 * garde donc que les lettres et les chiffres, diacritiques retires, exactement
 * comme le fait le tokenizer sur le reste du texte. La requete subit la meme
 * normalisation, ce qui garde les deux cotes alignes.
 */
export function normalizeHashtag(raw: string): string {
  const folded = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const kept = [...folded].filter((char) => /[\p{Letter}\p{Number}]/u.test(char)).join("");
  return kept === "" ? "" : `${TAG_PREFIX.HASHTAG}${kept}`;
}

/**
 * Le schema tient dans une seule constante parce qu il doit pouvoir etre relu
 * d un bloc : c est lui qui porte les invariants de performance decrits dans
 * docs/DECISION-INDEX.md.
 */
export const INDEX_DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE channel (
  id           INTEGER PRIMARY KEY,
  cid          TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  purpose      TEXT    NOT NULL,
  header       TEXT    NOT NULL,
  create_at    INTEGER NOT NULL,
  delete_at    INTEGER NOT NULL,
  posts        INTEGER NOT NULL,
  first_at     INTEGER,
  last_at      INTEGER
);

CREATE TABLE user (
  id        INTEGER PRIMARY KEY,
  uid       TEXT    NOT NULL UNIQUE,
  username  TEXT    NOT NULL,
  display   TEXT    NOT NULL,
  position  TEXT    NOT NULL,
  is_bot    INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  avatar    TEXT
);

CREATE TABLE emoji (
  name  TEXT PRIMARY KEY,
  image TEXT
) WITHOUT ROWID;

-- Avatars et emojis personnalises, copies dans l index.
--
-- Une page ouverte depuis le disque ne peut charger aucun fichier voisin, pas
-- meme celui d a cote : sans ces octets ici, le mode sans serveur afficherait
-- une archive sans visages ni emojis. Les pieces jointes, elles, restent en
-- metadonnees, leurs 26 Go n ayant pas vocation a voyager dans l index.
CREATE TABLE asset (
  kind TEXT NOT NULL,
  key  TEXT NOT NULL,
  mime TEXT NOT NULL,
  blob BLOB NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;

-- Le rowid porte l ordre chronologique global, et c est un invariant, pas une
-- commodite : il rend le tri par date gratuit, FTS5 parcourant sa liste a l
-- envers sans jamais lire une seule date. Mesure sans lui : 10 836 pages lues
-- pour un tri par date, contre 66 avec.
--
-- Le texte vit dans une table separee : sans lui, post pese 336 Mo au lieu de
-- 66 Mo, et toute operation qui filtre, trie ou pagine lit cinq fois plus de
-- pages pour rien.
CREATE TABLE post (
  rowid     INTEGER PRIMARY KEY,
  pid       TEXT    NOT NULL,
  ch        INTEGER NOT NULL REFERENCES channel(id),
  usr       INTEGER REFERENCES user(id),
  create_at INTEGER NOT NULL,
  root      INTEGER REFERENCES post(rowid),
  flags     INTEGER NOT NULL
);

CREATE TABLE post_text (
  rowid   INTEGER PRIMARY KEY REFERENCES post(rowid),
  message TEXT NOT NULL
);

CREATE TABLE reaction (
  post      INTEGER NOT NULL REFERENCES post(rowid),
  emoji     TEXT    NOT NULL,
  usr       INTEGER REFERENCES user(id),
  create_at INTEGER NOT NULL
);

-- Une piece jointe dont path vaut null a garde sa metadonnee et porte un
-- skip_reason : le viewer doit afficher "piece jointe non archivee" plutot que
-- de faire disparaitre une information qui existait.
CREATE TABLE file (
  id    INTEGER PRIMARY KEY,
  fid   TEXT    NOT NULL,
  post  INTEGER REFERENCES post(rowid),
  name  TEXT    NOT NULL,
  ext   TEXT    NOT NULL,
  size  INTEGER NOT NULL,
  mime  TEXT    NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  path  TEXT,
  skip_reason TEXT
);
`;

/**
 * Index crees apres le remplissage : les batir au fur et a mesure des insertions
 * coute plusieurs fois leur construction en une passe.
 */
export const INDEX_INDEXES = `
CREATE UNIQUE INDEX post_pid ON post(pid);
CREATE INDEX post_ch ON post(ch, rowid);
CREATE INDEX post_usr ON post(usr, rowid);
CREATE INDEX post_root ON post(root) WHERE root IS NOT NULL;
CREATE INDEX reaction_post ON reaction(post);
CREATE INDEX file_post ON file(post);
`;

/**
 * detail='full' porte les positions, donc la phrase exacte et la proximite.
 * detail='none' economiserait 80 Mo mais obligerait a relire jusqu a 2 300
 * messages disperses pour verifier une phrase, la ou full en lit 50 : tenable
 * sur un disque local, redhibitoire sur un index lu a distance.
 *
 * content='' parce que le viewer surligne lui meme : snippet() de FTS5 ignore le
 * Markdown, et le message complet est de toute facon deja lu pour l affichage.
 *
 * remove_diacritics 2 gere correctement les caracteres composes, contrairement
 * au mode 1 qui est conserve pour compatibilite ascendante.
 */
export const INDEX_FTS = `
CREATE VIRTUAL TABLE search USING fts5(
  message,
  tag,
  content='',
  detail='full',
  tokenize="unicode61 remove_diacritics 2"
);
`;
