/**
 * Ce que la saisie en cours attend comme suggestion.
 *
 * Logique pure, sans React ni DOM : c est la partie qui se trompe, et elle se
 * trompe sur des details de position que seul un test peut fixer.
 *
 * Le raisonnement porte sur le texte a GAUCHE du curseur, jamais sur le champ
 * entier. Quelqu un qui revient corriger `from:ali` au milieu de sa requete
 * attend des propositions pour ce mot-la, pas pour celui qu il a tape en
 * dernier.
 */

/** Modificateurs qui designent quelque chose de nommable. */
export const MODIFICATEURS = ["from", "in"] as const;

export type Modificateur = (typeof MODIFICATEURS)[number];

export interface Completion {
  readonly modificateur: Modificateur;
  /** Ce qui est deja tape apres le deux-points, eventuellement vide. */
  readonly prefixe: string;
  /** Bornes du fragment a remplacer, dans le texte complet. */
  readonly debut: number;
  readonly fin: number;
}

/**
 * Un modificateur en cours de saisie se termine au premier blanc.
 *
 * Les guillemets ne sont pas traites : `from:"jean dupont"` n existe pas dans la
 * syntaxe de recherche, un nom d utilisateur n ayant jamais d espace.
 */
const EN_COURS = /(?:^|\s)(from|in):([^\s]*)$/i;

/**
 * Rend ce qu il faut proposer, ou `undefined` s il n y a rien a proposer.
 *
 * `position` est l index du curseur. Elle vaut la longueur du texte dans le cas
 * ordinaire, mais pas quand on corrige au milieu, et c est le seul cas ou la
 * distinction se voit.
 */
export function completionEnCours(texte: string, position: number): Completion | undefined {
  const gauche = texte.slice(0, Math.max(0, Math.min(position, texte.length)));
  const trouve = EN_COURS.exec(gauche);
  if (trouve === null) return undefined;
  const prefixe = trouve[2] ?? "";
  const modificateur = (trouve[1] ?? "").toLowerCase() as Modificateur;
  return {
    modificateur,
    prefixe,
    // Le fragment a remplacer commence apres le deux-points et va jusqu au
    // curseur : ce qui suit appartient au reste de la requete.
    debut: gauche.length - prefixe.length,
    fin: gauche.length,
  };
}

/**
 * Remplace le fragment par la valeur choisie, et rend la position du curseur.
 *
 * Une espace est ajoutee derriere, parce qu on enchaine presque toujours sur un
 * autre terme, et qu il n en faut pas deux si l utilisateur en avait deja tape
 * une.
 */
export function appliquerCompletion(
  texte: string,
  completion: Completion,
  valeur: string,
): { texte: string; position: number } {
  const suite = texte.slice(completion.fin);
  const espace = suite.startsWith(" ") ? "" : " ";
  const avant = texte.slice(0, completion.debut) + valeur + espace;
  return { texte: avant + suite, position: avant.length };
}

export interface Suggestion {
  /** Valeur inseree dans le champ. */
  readonly valeur: string;
  /** Libelle affiche, plus lisible que la valeur quand les deux different. */
  readonly libelle: string;
  readonly detail?: string | undefined;
}

/** Nombre de propositions affichees. Au dela, la liste cesse d aider. */
export const MAX_SUGGESTIONS = 8;

/** Le plus court d abord, puis l ordre alphabetique, pour que le tri soit stable. */
function comparer(a: Suggestion, b: Suggestion): number {
  if (a.valeur.length !== b.valeur.length) return a.valeur.length - b.valeur.length;
  return a.valeur < b.valeur ? -1 : a.valeur > b.valeur ? 1 : 0;
}

/**
 * Classe les candidats : ceux qui commencent par le prefixe d abord.
 *
 * Chercher « martin » doit remonter « martin.dupont » avant « jean.martin »,
 * sans quoi la premiere proposition, celle que la touche Entree valide, est
 * rarement la bonne.
 */
export function filtrerSuggestions(
  candidats: readonly Suggestion[],
  prefixe: string,
): Suggestion[] {
  const cherche = prefixe.trim().toLowerCase();
  if (cherche === "") return candidats.slice(0, MAX_SUGGESTIONS);

  const commence: Suggestion[] = [];
  const contient: Suggestion[] = [];
  for (const candidat of candidats) {
    const valeur = candidat.valeur.toLowerCase();
    const libelle = candidat.libelle.toLowerCase();
    if (valeur.startsWith(cherche)) commence.push(candidat);
    else if (valeur.includes(cherche) || libelle.includes(cherche)) contient.push(candidat);
  }
  // Le plus court d abord parmi ceux qui commencent par le prefixe : c est le
  // plus proche de ce qui est tape. Sans ce tri l ordre etait celui de la liste
  // source, donc arbitraire, et taper le debut d un nom precis pouvait faire
  // remonter un homonyme plus long en premiere position, celle que la touche
  // Entree valide.
  commence.sort(comparer);
  contient.sort(comparer);
  return [...commence, ...contient].slice(0, MAX_SUGGESTIONS);
}
