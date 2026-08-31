/**
 * Ce que le rapport a le droit de savoir, et rien de plus.
 *
 * Le producteur de rapport ne recoit JAMAIS la table d identites. Il recoit des
 * ensembles, jamais l association : une signature structurellement incapable
 * d exprimer la correspondance vaut mieux qu une consigne de ne pas l ecrire.
 *
 * Les interdits qui ont dicte ces types, tous mesures sur l archive de
 * reference, valent d etre nommes ici parce qu ils se reintroduisent seuls des
 * qu on ajoute une ligne :
 *
 * - Aucune ligne par compte, quel que soit le chiffre porte. Les volumes se
 *   recomptent depuis l archive diffusee, donc deux listes se trient et
 *   s apparient rang par rang.
 * - Aucun decompte cle par une chaine d origine, meme sans imprimer la chaine.
 *   Apres la reecriture du texte, un pseudonyme apparaitra dans l archive autant
 *   de fois que la forme qu il remplace : compter les occurrences et lire la
 *   valeur en face suffit.
 * - Aucune classe d effectif inferieur a cinq. Un decompte a un n est pas un
 *   decompte, c est une designation.
 * - Aucun tri par volume, par date ou par ordre d origine. L ordre est un canal
 *   a part entiere.
 */

/** Categories de champs qui portent une reference a un compte, hors props. */
export type CategorieReference = "auteurs" | "reactions" | "fichiers" | "emojis";

export interface CompteursReference {
  reecrites: number;
  /**
   * References retirees faute de compte correspondant.
   *
   * Comptees par categorie : une reaction dont le compte a disparu de l instance
   * quittait l archive sans laisser de trace, donc sans que le rapport puisse en
   * rendre compte.
   */
  orphelines: number;
}

export type CompteursReferences = Record<CategorieReference, CompteursReference>;

export function compteursReferencesVides(): CompteursReferences {
  return {
    auteurs: { reecrites: 0, orphelines: 0 },
    reactions: { reecrites: 0, orphelines: 0 },
    fichiers: { reecrites: 0, orphelines: 0 },
    emojis: { reecrites: 0, orphelines: 0 },
  };
}

/** En deca, un effectif designe au lieu de decrire. */
export const SEUIL_EFFECTIF = 5;

/**
 * Rend un effectif publiable, ou la mention de sa suppression.
 *
 * Le controle se code une fois, au formatage, plutot qu au moment de se
 * rappeler la regle.
 */
export function effectifPublic(valeur: number): string {
  if (valeur === 0) return "0";
  return valeur < SEUIL_EFFECTIF ? `moins de ${String(SEUIL_EFFECTIF)}` : String(valeur);
}

/**
 * Pourcentage a une decimale au plus.
 *
 * Le denominateur figure dans le manifeste, qui est public : un taux a trois
 * decimales sur 3 277 comptes est un numerateur deguise.
 */
export function partPublique(numerateur: number, denominateur: number): string {
  if (denominateur === 0) return "sans objet";
  const virgule = (valeur: number): string => valeur.toFixed(1).replace(".", ",");
  // La borne se calcule sur le denominateur, elle ne s ecrit pas en dur : la
  // meme valeur serait fausse sur une archive d une autre taille, et le rapport
  // deviendrait faux la ou il se veut prudent.
  if (numerateur > 0 && numerateur < SEUIL_EFFECTIF) {
    return `moins de ${virgule((100 * SEUIL_EFFECTIF) / denominateur)} %`;
  }
  return `${virgule((100 * numerateur) / denominateur)} %`;
}

/** Une forme de texte residuelle, agregee par forme et jamais par occurrence. */
export interface FormeResiduelle {
  readonly forme: string;
  readonly occurrences: number;
  /** Canaux touches. L emplacement s arrete au canal, jamais au message. */
  readonly canaux: number;
  /** Vrai si la forme correspond a un prenom, nom ou surnom de l annuaire. */
  readonly connueDeLAnnuaire: boolean;
}

/** Canal dont le nom porte une identite, a relire avant diffusion. */
export interface CanalCandidat {
  readonly nom: string;
  readonly nomAffiche: string;
  /** Jeton qui a declenche la detection. */
  readonly jeton: string;
  /** Champ d ou vient le jeton : `name` ou `display_name`. */
  readonly champ: string;
  /** Nombre de comptes portant ce jeton. Un ou deux designe quelqu un. */
  readonly porteurs: number;
}

/** Identifiant de compte colle en clair dans le corps d un message. */
export interface IdentifiantColle {
  readonly postId: string;
  readonly canal: string;
  readonly occurrences: number;
}

/**
 * Mesures faites sur l archive PRODUITE, dans la passe du controle residuel.
 *
 * Tout ce qui a valeur probante se mesure sur ce qui serait diffuse, et non sur
 * la source : c est ce que le lecteur du rapport tient entre les mains.
 */
export interface MesuresSortie {
  messages: number;
  messagesSysteme: number;
  /** Mentions ancrees rencontrees. */
  mentions: number;
  /** Mentions deja reecrites, qui designent une identite de substitution. */
  mentionsPseudonymisees: number;
  /**
   * Mentions portant encore le nom d origine d un compte connu.
   *
   * Ce sont celles que la reecriture du texte saura traiter : elles resolvent.
   * Les compter a part de celles qui ne resolvent vers rien est ce qui distingue
   * un travail a faire d un residu definitif.
   */
  mentionsATraiter: number;
  mentionsCollectives: number;
  formesNonResolues: FormeResiduelle[];
  adresses: number;
  messagesAvecAdresse: number;
  adressesDistinctes: number;
  telephones: number;
  identifiantsColles: IdentifiantColle[];
  /**
   * Messages systeme dont le texte porte encore le nom d un compte.
   *
   * Zero est la valeur attendue : la passe substitue ces noms, et c est la
   * surface qu elle pretend traiter. Toute autre valeur est donc un echec de la
   * passe, pas un simple residu, et rend l archive non diffusable.
   *
   * Ce que ce compteur n etablit PAS, et que le rapport ne doit pas laisser
   * croire : que le nom trouve soit celui du compte que la ligne designe par
   * ailleurs sous son pseudonyme. Un message de A qui nomme B compte ici sans
   * apparier A. Etablir la relation demanderait la table des identites, que le
   * producteur de rapport n a pas, a dessein.
   */
  nomsResiduelsSysteme: number;
  /** Couples canal-jeton. Plusieurs jetons peuvent viser le meme canal. */
  canauxCandidats: CanalCandidat[];
  /** Canaux distincts concernes, qui est le nombre a annoncer. */
  canauxDistincts: number;
  emojisNommes: number;
  /** Distribution des volumes par compte, sans jamais nommer un compte. */
  compteLePlusActif: number;
  comptesAuDessusDeCent: number;
}

export function mesuresVides(): MesuresSortie {
  return {
    messages: 0,
    messagesSysteme: 0,
    mentions: 0,
    mentionsPseudonymisees: 0,
    mentionsATraiter: 0,
    mentionsCollectives: 0,
    formesNonResolues: [],
    adresses: 0,
    messagesAvecAdresse: 0,
    adressesDistinctes: 0,
    telephones: 0,
    identifiantsColles: [],
    nomsResiduelsSysteme: 0,
    canauxCandidats: [],
    canauxDistincts: 0,
    emojisNommes: 0,
    compteLePlusActif: 0,
    comptesAuDessusDeCent: 0,
  };
}
