/**
 * Vocabulaire de remplacement des noms ecrits en clair.
 *
 * C est la seule etape sans ancrage. Une mention commence par un arobase, une
 * adresse porte un domaine ; un prenom ne se distingue d un mot ordinaire par
 * rien. Tout le travail consiste donc a decider quelles formes valent d etre
 * remplacees, et le prix de l erreur n est pas le meme dans les deux sens : une
 * forme oubliee laisse une identite, une forme de trop abime du texte.
 *
 * Trois criteres, tous mesures sur l archive de reference.
 *
 * La LONGUEUR. Treize formes du vocabulaire font deux caracteres, et deux
 * d entre elles paraissent 1 429 800 et 643 499 fois : ce sont des mots
 * francais que quelqu un porte aussi comme surnom. En dessous de quatre
 * caracteres, une forme ne designe plus personne en particulier.
 *
 * Le NOMBRE DE PORTEURS. Une forme portee par trente comptes est un prenom
 * repandu, pas un identifiant : la remplacer ne protege personne en
 * particulier et abime tous les usages ordinaires du mot.
 *
 * La FREQUENCE dans le corpus, qui est le critere decisif et le seul qui
 * demande de lire l archive. Une forme qui parait plus de deux cents fois n est
 * presque jamais une personne citee deux cents fois. Neuf formes font a elles
 * seules la moitie des occurrences du vocabulaire, et ce sont toutes des mots
 * ordinaires.
 *
 * Ce que ces seuils laissent passer est chiffre et annonce, jamais tu : 186
 * comptes de l archive de reference restent nommables quel que soit le reglage,
 * leurs formes etant trop courtes ou trop partagees.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_LAYOUT, type ArchivePost, type ArchiveUser } from "@mmarchive/shared";
import { readNdjson } from "@mmarchive/shared/ndjson";

/** En deca, une forme ne designe plus personne en particulier. */
const LONGUEUR_MINIMALE = 4;

/** Au dela, une forme est un prenom repandu et non un identifiant. */
const PORTEURS_MAXIMUM = 5;

export interface VocabulaireNoms {
  /** Formes retenues, normalisees, vers l identite a substituer. */
  readonly formes: ReadonlyMap<string, string>;
  /** Formes ecartees faute d etre assez rares, pour le rapport. */
  readonly ecarteesParFrequence: number;
  /**
   * Comptes qui portent un nom dans l annuaire et dont aucune forme n a pu etre
   * retenue : trop courte, trop partagee, ou trop frequente dans le corpus.
   *
   * Ce sont eux qui restent nommables en clair, et c est le chiffre que le
   * rapport annonce. Les comptes sans aucun nom au repertoire n y figurent pas :
   * l outil ne peut pas les nommer, donc ils ne courent pas ce risque-la.
   */
  readonly comptesNonCouverts: number;
  readonly comptesCouverts: number;
}

/** Retire les diacritiques et met en minuscules, comme partout ailleurs. */
export function normaliserForme(valeur: string): string {
  return valeur.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Formes candidates d un compte, avant tout filtrage par frequence.
 *
 * Les formes composees d un espace ne sont pas retenues : elles se
 * chevaucheraient avec leurs moities, et le remplacement se fait mot a mot.
 */
export function formesCandidates(user: ArchiveUser): Set<string> {
  const formes = new Set<string>();
  for (const champ of [user.first_name, user.last_name, user.nickname]) {
    const forme = normaliserForme(champ);
    if (forme !== "" && !forme.includes(" ")) formes.add(forme);
  }
  return formes;
}

/** Vrai si cette forme est assez longue pour designer quelqu un. */
export function formeAssezLongue(forme: string): boolean {
  return forme.length >= LONGUEUR_MINIMALE;
}

/**
 * Construit le vocabulaire a partir de l annuaire et des frequences mesurees.
 *
 * `frequences` vient d une passe de comptage sur le corpus : elle ne se devine
 * pas, et c est ce qui distingue un prenom d un mot. Une forme absente de la
 * table n a jamais ete rencontree, donc sa frequence est nulle.
 */
export function construireVocabulaire(
  users: Iterable<ArchiveUser>,
  substitution: ReadonlyMap<string, string>,
  frequences: ReadonlyMap<string, number>,
  seuilFrequence: number,
): VocabulaireNoms {
  const porteurs = new Map<string, number>();
  const parCompte: { id: string; formes: Set<string> }[] = [];
  for (const user of users) {
    const formes = formesCandidates(user);
    if (formes.size === 0) continue;
    parCompte.push({ id: user.id, formes });
    for (const forme of formes) {
      if (formeAssezLongue(forme)) porteurs.set(forme, (porteurs.get(forme) ?? 0) + 1);
    }
  }

  const formes = new Map<string, string>();
  let ecarteesParFrequence = 0;
  const vues = new Set<string>();
  for (const { id, formes: candidates } of parCompte) {
    for (const forme of candidates) {
      // Une forme trop courte reste comptee comme candidate, pour que le compte
      // qui n en a pas d autre apparaisse au rapport comme restant nommable.
      // L ecarter en amont le faisait disparaitre des deux colonnes, et
      // l archive paraissait plus sure qu elle ne l est.
      if (!formeAssezLongue(forme)) continue;
      if ((porteurs.get(forme) ?? 0) > PORTEURS_MAXIMUM) continue;
      if ((frequences.get(forme) ?? 0) > seuilFrequence) {
        if (!vues.has(forme)) {
          vues.add(forme);
          ecarteesParFrequence += 1;
        }
        continue;
      }
      const nom = substitution.get(id);
      // Une forme portee par deux comptes est remplacee par le pseudonyme du
      // premier rencontre. C est arbitraire et sans consequence : les deux sont
      // des pseudonymes, et l objectif est que le nom reel disparaisse.
      if (nom !== undefined && !formes.has(forme)) formes.set(forme, nom);
    }
  }

  let comptesCouverts = 0;
  for (const { formes: candidates } of parCompte) {
    if ([...candidates].some((forme) => formes.has(forme))) comptesCouverts += 1;
  }

  return {
    formes,
    ecarteesParFrequence,
    comptesCouverts,
    comptesNonCouverts: parCompte.length - comptesCouverts,
  };
}

/** Mots d un texte, tels que le remplacement les verra. */
const MOT = /[\p{L}\p{M}]{4,}/gu;

/**
 * Compte, sur le corpus, la frequence de chaque forme candidate.
 *
 * C est une passe de lecture supplementaire, et elle n a lieu qu au niveau qui
 * remplace les noms. Elle ne se remplace par aucune heuristique : distinguer un
 * prenom d un mot ordinaire demande de savoir combien de fois le mot parait, et
 * cette information n existe que dans l archive qu on traite. Une liste de mots
 * francais embarquee dirait ce qu est un mot du dictionnaire, pas ce qu est un
 * mot de ce corpus.
 *
 * Ne compte que les formes candidates, donc la table reste bornee par l annuaire
 * et non par le vocabulaire du corpus.
 */
export async function compterFrequences(
  racine: string,
  candidates: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const frequences = new Map<string, number>();
  if (candidates.size === 0) return frequences;

  const compter = (texte: string): void => {
    if (texte === "") return;
    for (const mot of normaliserForme(texte).match(MOT) ?? []) {
      if (candidates.has(mot)) frequences.set(mot, (frequences.get(mot) ?? 0) + 1);
    }
  };

  const postsDir = join(racine, ARCHIVE_LAYOUT.postsDir);
  for (const nom of await readdir(postsDir)) {
    if (!nom.endsWith(".ndjson")) continue;
    for await (const post of readNdjson<ArchivePost>(join(postsDir, nom))) {
      compter(post.message);
      // Le texte des blocs compte autant : une forme qui y parait des milliers
      // de fois est un gabarit d integration, pas une personne.
      const blocs = post.props["attachments"];
      if (!Array.isArray(blocs)) continue;
      for (const bloc of blocs) {
        if (typeof bloc !== "object" || bloc === null) continue;
        for (const valeur of Object.values(bloc as Record<string, unknown>)) {
          if (typeof valeur === "string") compter(valeur);
          else if (Array.isArray(valeur)) {
            for (const champ of valeur) {
              if (typeof champ !== "object" || champ === null) continue;
              for (const v of Object.values(champ as Record<string, unknown>)) {
                if (typeof v === "string") compter(v);
              }
            }
          }
        }
      }
    }
  }
  return frequences;
}
