/**
 * Fusion des deux moities de la recherche hybride.
 *
 * Combinaison convexe de scores normalises, et non fusion par rang reciproque.
 * RRF a ete concu pour fusionner beaucoup de systemes, trente configurations
 * dans l article d origine ; sur deux listes, la combinaison convexe le bat de
 * 0,015 a 0,032 point de nDCG dans deux mesures independantes. Voir
 * docs/DECISION-RAG.md.
 *
 * Fonction pure, sans base ni reseau : c est ici que se decide quel fragment le
 * modele lira, et cela doit s eprouver avec deux listes fabriquees a la main.
 */

export interface ScoredHit {
  readonly fragment: number;
  /** Plus grand vaut mieux, des deux cotes. */
  readonly score: number;
}

export interface FusedHit {
  readonly fragment: number;
  readonly score: number;
  /** Ce que chaque moitie a apporte, pour pouvoir expliquer un classement. */
  readonly lexical: number;
  readonly vector: number;
  /** Vrai quand une seule des deux moities a trouve ce fragment. */
  readonly alone: boolean;
}

export interface FusionOptions {
  /**
   * Part du vectoriel dans le score final, entre 0 et 1.
   *
   * 0,7 est le milieu de la fourchette etayee. La valeur exacte se regle sur des
   * questions reelles : l hybride n est pas gratuit, et sur des questions
   * purement conceptuelles le vectoriel seul fait mieux que le melange.
   */
  readonly vectorWeight?: number;
  readonly limit?: number;
}

export const DEFAULT_VECTOR_WEIGHT = 0.7;
export const DEFAULT_FUSION_LIMIT = 12;

/**
 * Ramene une liste de scores sur [0, 1], le meilleur a 1.
 *
 * Deux echelles sans rapport se combinent mal : un bm25 va de zero a quelques
 * dizaines, une similarite cosinus tient dans [-1, 1]. Sans mise a l echelle, le
 * poids annonce ne serait pas le poids applique.
 *
 * Quand tous les scores sont egaux, la normalisation les met tous a 1 plutot
 * qu a zero : ils sont ex aequo, pas mauvais. Les mettre a zero effacerait toute
 * une moitie de la fusion des qu elle ne discrimine pas.
 *
 * Une propriete a connaitre : le plus faible score d une liste tombe a zero,
 * donc le dernier candidat d une moitie y compte autant qu un absent. C est le
 * comportement usuel d une mise a l echelle par les bornes, et il est sans
 * consequence sur une cinquantaine de candidats ou l ecart se repartit ; c est
 * le champ `alone` qui distingue « vu et mal classe » de « pas vu ».
 */
function normaliser(cote: string, hits: readonly ScoredHit[]): Map<number, number> {
  if (hits.length === 0) return new Map();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const h of hits) {
    // Un score qui n est pas un nombre fini ne se classe pas. Le laisser passer
    // le rendrait invisible : NaN echappe aux comparaisons, donc il traverserait
    // le calcul des bornes sans rien declencher pour ressortir en score fusionne
    // NaN, et le tri renverrait alors les candidats dans leur ordre d arrivee.
    // Il vaut mieux nommer le fragment fautif que de classer au hasard.
    if (!Number.isFinite(h.score)) {
      throw new RangeError(
        `Score ${cote} non exploitable pour le fragment ${String(h.fragment)} : ${String(h.score)}.`,
      );
    }
    if (h.score < min) min = h.score;
    if (h.score > max) max = h.score;
  }
  const etendue = max - min;
  return new Map(hits.map((h) => [h.fragment, etendue === 0 ? 1 : (h.score - min) / etendue]));
}

/**
 * Combine les deux classements.
 *
 * Un fragment trouve par une seule moitie n est pas ecarte : il recoit zero dans
 * l autre, ce qui vaut « le pire de ce qu on a vu » et non « exclu ». C est la
 * contrainte qu on rate le plus souvent en implementant une combinaison convexe,
 * et l ecarter reviendrait a ne garder que l intersection des deux moities,
 * c est a dire a perdre exactement ce que l hybride cherche a gagner : le
 * fragment que le vectoriel seul voit, et celui que seul un mot rare designe.
 */
export function fuse(
  lexical: readonly ScoredHit[],
  vector: readonly ScoredHit[],
  options: FusionOptions = {},
): FusedHit[] {
  const poids = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  if (poids < 0 || poids > 1 || !Number.isFinite(poids)) {
    throw new RangeError(`Le poids du vectoriel doit tenir entre 0 et 1, recu ${String(poids)}.`);
  }
  const limit = options.limit ?? DEFAULT_FUSION_LIMIT;
  // Sans ce controle, une limite negative rendrait « tout sauf les derniers »
  // par le comportement de slice, et une limite fractionnaire serait arrondie
  // en silence. Refuser vaut mieux que de rendre autre chose que demande.
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(
      `Le nombre de fragments doit etre un entier positif, recu ${String(limit)}.`,
    );
  }

  const lex = normaliser("lexical", lexical);
  const vec = normaliser("vectoriel", vector);

  const fusionnes: FusedHit[] = [];
  for (const fragment of new Set([...lex.keys(), ...vec.keys()])) {
    const l = lex.get(fragment) ?? 0;
    const v = vec.get(fragment) ?? 0;
    fusionnes.push({
      fragment,
      score: poids * v + (1 - poids) * l,
      lexical: l,
      vector: v,
      alone: !lex.has(fragment) || !vec.has(fragment),
    });
  }

  // A egalite, le plus petit identifiant passe devant : un classement stable
  // rend deux executions comparables, ce dont depend tout reglage ulterieur.
  fusionnes.sort((a, b) => b.score - a.score || a.fragment - b.fragment);
  return fusionnes.slice(0, limit);
}
