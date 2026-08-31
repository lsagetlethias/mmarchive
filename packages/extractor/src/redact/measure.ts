/**
 * Detecteurs de ce qui ressemble a une identite dans du texte.
 *
 * Ils servent au rapport, jamais a decider d une reecriture : le rapport dit ce
 * qui reste, il ne corrige rien. Chacun est donc regle pour compter juste plutot
 * que pour attraper large, et chacun dit ce qu il rate.
 */

/**
 * Mention Mattermost.
 *
 * Le corps admet les lettres Unicode, et ce n est pas un raffinement. Une classe
 * ASCII coupe « @Stephane » sur sa lettre accentuee et n en garde que le debut :
 * 657 mentions de l archive de reference etaient ainsi tronquees, et les
 * neutraliser aurait laisse la queue du nom en clair, c est a dire exactement le
 * masquage partiel que le cadrage ecarte par principe.
 *
 * L ancrage empeche qu une adresse produise une mention a chaque arobase :
 * devant l arobase d une adresse il y a toujours un caractere de sa partie
 * locale. Le point, le tiret et l arobase n y figurent PAS, faute de quoi
 * « @@nom », « .@nom » et « -@nom » passeraient inapercus, ce qui vaut 127
 * occurrences ou un nom de compte connu suit un arobase.
 *
 * Le nom ne peut pas finir par un point : Mattermost lui-meme retire la
 * ponctuation finale avant de resoudre, et « @alice. » en fin de phrase designe
 * bien « alice ».
 */
export const CORPS_MENTION = String.raw`[\p{L}\p{N}_-][\p{L}\p{N}._-]*[\p{L}\p{N}_-]|[\p{L}\p{N}_-]`;

const MENTION = new RegExp(String.raw`(?<![\p{L}\p{N}_%+])@(${CORPS_MENTION})`, "gu");

/** Mentions qui ne designent personne en particulier. */
const MENTIONS_COLLECTIVES = new Set(["all", "channel", "here"]);

/**
 * Vrai pour une mention qui ne designe personne.
 *
 * Partage avec la reecriture : sans cette distinction, les 3 584 occurrences de
 * l archive de reference tombent dans la branche des mentions non resolues et se
 * font neutraliser, ce qui abime autant de messages pour zero identite.
 */
export function estMentionCollective(forme: string): boolean {
  return MENTIONS_COLLECTIVES.has(forme.toLowerCase());
}

/**
 * Adresse electronique.
 *
 * Volontairement plus stricte que la RFC, qui autorise des formes qu on ne
 * rencontre pas : ce motif sert a compter ce qui subsiste, et une regle trop
 * large ferait passer pour des adresses des identifiants de paquets ou des
 * chemins.
 */
export const LOCAL_ADRESSE = String.raw`[\p{L}\p{N}._%+-]+`;

const ADRESSE = new RegExp(
  String.raw`${LOCAL_ADRESSE}@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])`,
  "gu",
);

/**
 * Adresse precedee d un arobase, la forme `@local@domaine`.
 *
 * 56 occurrences dans les corps de l archive de reference, dont 17 ou la partie
 * locale designe un compte connu. Aucun ordre generique ne la traite
 * correctement : la voir d abord comme une mention laisse `@pseudonyme@domaine`,
 * que la regle d adresse remange ensuite, le pseudonyme disparaissant avec ; la
 * voir d abord comme une adresse est sur mais perd le fil dans les 17 cas
 * resolus. D ou un cas nomme, en tete de l alternation.
 */
export const ADRESSE_MENTION = new RegExp(
  String.raw`@(${LOCAL_ADRESSE})@[\p{L}\p{N}.-]+\.[\p{L}]{2,}`,
  "u",
);

/**
 * Numero de telephone francais.
 *
 * Ancre sur la classe de mot et non sur le seul chiffre : sans cela le motif se
 * colle a une lettre ou a un tiret bas et ramasse un fragment de jeton
 * technique, ce qui vaut 287 detections sur l archive de reference.
 *
 * Ancre des deux cotes, et surtout **le separateur doit etre le meme partout**,
 * ce que la reference arriere impose. Le rendre optionnel a chaque groupe
 * acceptait des formes hybrides qui n existent pas : sur l archive de reference,
 * 5 994 des 7 812 detections etaient des identifiants du type `01-23456789` dans
 * des offres d emploi, plus des fragments d UUID et des couleurs hexadecimales.
 * Quatre detections sur cinq etaient fausses, et le rapport les annoncait comme
 * des numeros de telephone.
 *
 * Ce qu il rate, et qui doit figurer au rapport a cote du chiffre : les formats
 * etrangers, les numeros ecrits en toutes lettres, et ceux coupes par un retour
 * a la ligne.
 */
const TELEPHONE =
  /(?<![\p{L}\p{N}_])(?:\+33\s?|0)[1-9](?:([\s.-]?)[0-9]{2}(?:\1[0-9]{2}){3})(?![\p{L}\p{N}_])/gu;

/** Identifiant Mattermost isole dans du texte. */
const IDENTIFIANT = /(?<![A-Za-z0-9])[a-z0-9]{26}(?![A-Za-z0-9])/g;

export interface MentionsTrouvees {
  readonly formes: readonly string[];
  readonly collectives: number;
}

/**
 * Formes mentionnees dans un texte, ponctuation finale retiree.
 *
 * Rend les formes et non les occurrences : l agregation se fait par forme, et
 * une forme vue une seule fois designe une personne aussi surement qu un nom.
 */
export function mentionsDe(texte: string): MentionsTrouvees {
  if (!texte.includes("@")) return { formes: [], collectives: 0 };
  const formes: string[] = [];
  let collectives = 0;
  for (const trouve of texte.matchAll(MENTION)) {
    const forme = (trouve[1] ?? "").replace(/[.]+$/, "");
    if (forme === "") continue;
    if (estMentionCollective(forme)) collectives += 1;
    else formes.push(forme);
  }
  return { formes, collectives };
}

export function adressesDe(texte: string): readonly string[] {
  if (!texte.includes("@")) return [];
  return [...texte.matchAll(ADRESSE)].map((t) => t[0]);
}

export function telephonesDe(texte: string): number {
  return [...texte.matchAll(TELEPHONE)].length;
}

/**
 * Identifiants de 26 caracteres presents dans un texte, occurrences comprises.
 *
 * Les repetitions sont conservees : l appelant en compte des occurrences, et
 * dedupliquer ici ferait annoncer moins d occurrences qu il n y en a.
 */
export function identifiantsDe(texte: string): readonly string[] {
  return [...texte.matchAll(IDENTIFIANT)].map((t) => t[0]);
}
