/**
 * Moitie lexicale de la recherche hybride.
 *
 * Elle existe parce que le vectoriel rate ce qui n a pas de voisin semantique :
 * un acronyme maison, un nom de projet, un identifiant de ticket. Sur un journal
 * de conversation d entreprise, c est precisement ce que les gens cherchent.
 *
 * Rien a voir avec la recherche du viewer, qui rend les messages dans l ordre
 * chronologique parce qu un lecteur veut du contexte. Ici l ordre est celui de
 * la pertinence, et le score compte autant que le rang : la fusion en aura
 * besoin pour ponderer les deux moities l une par rapport a l autre.
 */
import type { DatabaseSync } from "node:sqlite";

export interface LexicalHit {
  readonly fragment: number;
  /**
   * Score de pertinence, d autant plus grand que le fragment repond mieux.
   *
   * SQLite rend un bm25 negatif, le meilleur etant le plus bas. Le signe est
   * inverse ici plutot qu au moment de fusionner : une echelle ou « plus grand
   * vaut mieux » est la seule qui se combine sans piege avec la similarite
   * vectorielle, qui suit deja cette convention.
   */
  readonly score: number;
}

/**
 * Mots d une question, ramenes a la forme sous laquelle l index les connait.
 *
 * Les accents tombent, comme le fait `remove_diacritics 2` du cote de FTS5. Ce
 * n est pas cosmetique : le vocabulaire de l index ne contient que des formes
 * sans accent, donc chercher la frequence de « ete » y repond et celle de
 * « ete » accentue n y repond pas. Sans cette normalisation, aucun mot accentue
 * n est jamais reconnu comme repandu, ce qui vide le filtrage de son sens sur
 * une archive francaise.
 */
export function questionWords(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((mot) => mot.length > 1),
    ),
  ];
}

/** Neutralise un mot pour FTS5, ou les operateurs deviennent litteraux. */
function quote(mot: string): string {
  return `"${mot.replace(/"/g, '""')}"`;
}

/** Expression FTS5 pour une liste de mots deja normalisee. */
export function wordsToMatch(mots: readonly string[]): string {
  return mots.map(quote).join(" OR ");
}

/**
 * Transforme une liste de mots en expression FTS5.
 *
 * Les mots sont relies par OU et non par ET : une question de dix mots dont
 * chacun devrait apparaitre ne trouverait rien. C est au classement de trier,
 * et bm25 recompense justement les fragments qui en portent le plus, et les
 * plus rares.
 *
 * Chaque mot passe entre guillemets, ce qui neutralise les operateurs de FTS5.
 * Sans cela, une question contenant « ET », « OR » ou une parenthese changerait
 * le sens de la requete, voire la rendrait invalide.
 */
export function questionToMatch(question: string): string {
  return wordsToMatch(questionWords(question));
}

/**
 * Part du corpus au dela de laquelle un mot ne discrimine plus rien.
 *
 * Mesure sur l archive de reference : « le » figure dans 155 580 fragments sur
 * 297 515, « sur » dans 124 371. Deux mots suffisent donc a faire scorer la
 * moitie du corpus pour n apporter aucune information, bm25 les annulant de
 * toute facon par leur frequence. Les ecarter divise la duree d une question
 * ordinaire par quatre sans deplacer les premiers resultats.
 *
 * Le seuil se mesure sur le corpus plutot que de s appuyer sur une liste de mots
 * vides : une liste vaut pour une langue, un seuil vaut pour n importe laquelle,
 * et s ajuste tout seul a un corpus ou « archive » serait devenu banal.
 */
export const COMMON_WORD_RATIO = 0.1;

/**
 * Ecarte les mots trop repandus pour discriminer, sauf s ils sont tout ce qu il
 * reste : une question qui n en contiendrait que ne doit pas devenir muette.
 */
export function pruneCommonWords(store: DatabaseSync, mots: readonly string[]): string[] {
  if (mots.length <= 1) return [...mots];
  const total = Number(store.prepare("SELECT count(*) AS n FROM fragment").get()?.n ?? 0);
  if (total === 0) return [...mots];

  let frequences: Map<string, number>;
  try {
    store.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.fragment_vocab USING fts5vocab(main, fragment_fts, 'row')",
    );
    const rows = store
      .prepare(
        `SELECT term, doc FROM temp.fragment_vocab WHERE term IN (${mots.map(() => "?").join(", ")})`,
      )
      .all(...mots);
    frequences = new Map(rows.map((row) => [String(row.term), Number(row.doc)]));
  } catch {
    // Sans statistiques de vocabulaire, chercher tous les mots reste correct,
    // seulement plus lent. Ce n est pas une raison de refuser de repondre.
    return [...mots];
  }

  const gardes = mots.filter((mot) => (frequences.get(mot) ?? 0) <= total * COMMON_WORD_RATIO);
  return gardes.length === 0 ? [...mots] : gardes;
}

export interface LexicalOptions {
  readonly limit?: number;
  /** Restreint la recherche a certains canaux. */
  readonly channels?: readonly number[];
}

export const LEXICAL_DEFAULT_LIMIT = 50;

/**
 * Fragments les plus pertinents pour cette question, du meilleur au moins bon.
 *
 * Une question sans mot exploitable rend une liste vide plutot qu une erreur :
 * c est un resultat, pas une panne, et la moitie vectorielle peut tres bien
 * repondre seule.
 */
export function searchLexical(
  store: DatabaseSync,
  question: string,
  options: LexicalOptions = {},
): LexicalHit[] {
  const match = wordsToMatch(pruneCommonWords(store, questionWords(question)));
  if (match === "") return [];

  const limit = options.limit ?? LEXICAL_DEFAULT_LIMIT;
  const canaux = options.channels ?? [];
  const filtre = canaux.length === 0 ? "" : ` AND f.ch IN (${canaux.map(() => "?").join(", ")})`;

  const rows = store
    .prepare(
      `SELECT f.rowid AS fragment, bm25(fragment_fts) AS rang
       FROM fragment_fts
       JOIN fragment f ON f.rowid = fragment_fts.rowid
       WHERE fragment_fts MATCH ?${filtre}
       ORDER BY rang
       LIMIT ?`,
    )
    .all(match, ...canaux, limit);

  return rows.map((row) => ({
    fragment: Number(row.fragment),
    score: -Number(row.rang),
  }));
}
