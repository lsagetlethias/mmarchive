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
 * fait parfois preceder d un arobase.
 */
const JETON = /[A-Za-z0-9._-]{2,}/g;

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

function echapper(valeur: string): string {
  return valeur.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rend le texte du message, noms substitues.
 *
 * `props` est celui d ORIGINE, avant reduction : c est lui qui porte encore les
 * noms tels qu ils apparaissent dans le texte.
 */
export function reecrireNomsDesignes(
  post: ArchivePost,
  resolveur: ResolveurIdentite,
): ReecritureTexte {
  let message = post.message;
  let substitutions = 0;
  let nonTrouves = 0;

  for (const cle of NOMS_DANS_LE_TEXTE) {
    const nom = post.props[cle];
    if (typeof nom !== "string" || nom === "") continue;
    const identite = resolveur.parUsername(nom);
    // Un nom que l annuaire ne connait pas ne peut pas etre substitue, et n a pas
    // a l etre : `props` retire la cle, donc la ligne n apparie plus rien. Le nom
    // reste dans le texte, comme tous ceux du corps des messages.
    if (identite === undefined) continue;
    // Le nom est parfois precede d un arobase dans le texte, parfois nu. Les
    // deux formes designent la meme personne et se remplacent pareil.
    const motif = new RegExp(echapper(nom), "g");
    let occurrences = 0;
    message = message.replace(motif, () => {
      occurrences += 1;
      return identite.username;
    });
    if (occurrences === 0) nonTrouves += 1;
    else substitutions += occurrences;
  }

  // Second passage, sur les seuls messages systeme : leur texte est ecrit par
  // Mattermost et non par un humain, il est court et contraint.
  //
  // Il est necessaire parce que `props` ne suffit pas. Un compte qui a change de
  // nom laisse un message fige sur l ancien, tandis que `props` porte le nouveau
  // : « @julien a rejoint le canal » a cote d un `props.username` valant
  // « julien.dauphant ». Le premier passage ne trouve rien a remplacer, et la
  // ligne continue d apparier un nom reel avec le pseudonyme que porte
  // `post.user_id`. Retirer `props` n y suffirait pas, pour la meme raison.
  if (post.type.startsWith("system_")) {
    message = message.replace(JETON, (jeton) => {
      if (jeton.length < LONGUEUR_JETON_MINIMALE) return jeton;
      const identite = resolveur.parUsername(jeton);
      if (identite === undefined) return jeton;
      substitutions += 1;
      return identite.username;
    });
  }

  return { message, substitutions, nonTrouves };
}
