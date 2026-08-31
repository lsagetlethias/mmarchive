/**
 * Substitution des noms que `props` designe dans le texte du message.
 *
 * Sans elle, l archive anonymisee porte la table de correspondance en clair.
 * Mesure sur l archive de reference : 65 577 messages systeme sur 67 401 ont un
 * texte du type « alice a ete ajoute au canal par bob » que la passe laissait
 * intact, a cote d un `props.addedUsername` reecrit en
 * `anon-rabot-alerte`. Une seule ligne apparie donc l identite reelle et
 * l identite de substitution, et il y en a assez pour couvrir 3 237 comptes sur
 * 3 277, soit 98,8 %. Le sel jete ne protege de rien quand la reponse est ecrite
 * a cote de la question.
 *
 * Ce n est pas la reecriture de texte generale, qui reste a faire. Elle procede
 * en deux temps, du plus sur au moins sur.
 *
 * Le premier temps ne devine rien : le nom a remplacer est lu dans `props`, qui
 * le porte pour cette raison meme, sur n importe quel message. Aucun faux
 * positif possible.
 *
 * Le second ne porte que sur les messages systeme, dont le texte est ecrit par
 * Mattermost et non par un humain, et y remplace tout jeton qui est un nom de
 * compte connu. Celui-la peut se tromper, sur un nom d utilisateur qui serait
 * aussi un mot ordinaire, et c est assume : le cadrage privilegie l anonymat,
 * un texte un peu abime restant exploitable la ou une identite qui fuit ne se
 * rattrape pas. Il est necessaire parce qu un compte ayant change de nom laisse
 * un message fige sur l ancien, que `props` ne nomme plus.
 */
import type { ArchivePost } from "@mmarchive/shared";
import type { ResolveurIdentite } from "./props-filter.js";

/** Cles de `props` dont la valeur est un nom de compte repris dans le texte. */
const NOMS_DANS_LE_TEXTE = ["username", "addedUsername", "removedUsername"] as const;

/**
 * Jetons d un texte systeme, tels que Mattermost les y ecrit.
 *
 * Un nom d utilisateur Mattermost n admet que ces caracteres, et le gabarit le
 * fait parfois preceder d un arobase, qui n en fait pas partie.
 *
 * Le jeton ne peut pas finir par un point, qui est de la ponctuation : sinon
 * « bob. » cesse de correspondre au « bob » que `props` designe. Il peut finir
 * par un tiret bas ou un tiret, qui n en sont pas et appartiennent aux noms :
 * un compte de l archive de reference s appelle « vermeer_ », et le tronquer
 * laissait dix-neuf messages porter son nom en clair.
 */
const JETON = /[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/g;

/**
 * En deca, un nom d utilisateur se confond avec un mot ordinaire.
 *
 * Mesure sur les 67 401 messages systeme de l archive de reference : 65 220
 * jetons correspondent a un compte, dont 414 seulement font moins de quatre
 * caracteres. Les ecarter coute 0,6 % de couverture et evite qu un compte nomme
 * « r » fasse remplacer chaque lettre isolee du texte.
 */
const LONGUEUR_JETON_MINIMALE = 4;

export interface ReecritureTexte {
  readonly message: string;
  /** Noms substitues, un par occurrence dans le texte. */
  readonly substitutions: number;
  /**
   * Noms designes par `props` mais introuvables dans le texte.
   *
   * Sans consequence : `props` retire la cle quand elle ne resout pas, donc rien
   * n apparie. Compte pour que le rapport puisse dire ce que la passe n a pas su
   * traiter plutot que de le taire.
   */
  readonly nonTrouves: number;
}

/**
 * Rend le texte du message, noms substitues.
 *
 * `props` est celui d ORIGINE, avant reduction : c est lui qui porte encore les
 * noms tels qu ils apparaissent dans le texte.
 *
 * Les deux passages travaillent sur des JETONS entiers et jamais sur une
 * sous-chaine. Un remplacement brut de la valeur de `props` atteindrait
 * l interieur des mots : un compte nomme « bob » transformerait « bobcat » en
 * « anon-quartz-agilecat ».
 */
export function reecrireNomsDesignes(
  post: ArchivePost,
  resolveur: ResolveurIdentite,
): ReecritureTexte {
  const designes = new Set<string>();
  for (const cle of NOMS_DANS_LE_TEXTE) {
    const nom = post.props[cle];
    if (typeof nom === "string" && nom !== "") designes.add(nom);
  }

  const systeme = post.type.startsWith("system_");
  if (designes.size === 0 && !systeme) {
    return { message: post.message, substitutions: 0, nonTrouves: 0 };
  }

  let substitutions = 0;
  const rencontres = new Set<string>();
  const message = post.message.replace(JETON, (jeton) => {
    // Un nom que `props` designe nommement se substitue quelle que soit sa
    // longueur : il n y a rien a deviner. Les autres jetons d un message systeme
    // ne se substituent qu au dela de la longueur minimale.
    const designe = designes.has(jeton);
    if (!designe && (!systeme || jeton.length < LONGUEUR_JETON_MINIMALE)) return jeton;
    const identite = resolveur.parUsername(jeton);
    if (identite === undefined) return jeton;
    if (designe) rencontres.add(jeton);
    substitutions += 1;
    return identite.username;
  });

  // Un nom designe par `props` mais absent du texte n a pas de consequence :
  // `props` retire la cle quand elle ne resout pas, donc rien n apparie. Compte
  // pour que le rapport puisse le dire plutot que de le taire.
  let nonTrouves = 0;
  for (const nom of designes) {
    if (!rencontres.has(nom) && resolveur.parUsername(nom) !== undefined) nonTrouves += 1;
  }

  return { message, substitutions, nonTrouves };
}
