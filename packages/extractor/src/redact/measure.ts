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
 * Ancree sur un caractere qui ne fait pas partie d un nom, sans quoi une adresse
 * electronique produirait une mention a chaque arobase. L ancrage couvre toute
 * la classe admise dans une partie locale d adresse, `%` et `+` compris : sans
 * eux, six adresses de l archive de reference produisaient une mention. Le nom ne peut pas finir
 * par un point : Mattermost lui-meme retire la ponctuation finale avant de
 * resoudre, et « @alice. » en fin de phrase designe bien « alice ».
 */
const MENTION = /(?<![A-Za-z0-9._%+@-])@([A-Za-z0-9_-][A-Za-z0-9._-]*[A-Za-z0-9_-]|[A-Za-z0-9_-])/g;

/** Mentions qui ne designent personne en particulier. */
const MENTIONS_COLLECTIVES = new Set(["all", "channel", "here"]);

/**
 * Adresse electronique.
 *
 * Volontairement plus stricte que la RFC, qui autorise des formes qu on ne
 * rencontre pas : ce motif sert a compter ce qui subsiste, et une regle trop
 * large ferait passer pour des adresses des identifiants de paquets ou des
 * chemins.
 */
const ADRESSE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Numero de telephone francais.
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
const TELEPHONE = /(?<![0-9])(?:\+33\s?|0)[1-9](?:([\s.-]?)[0-9]{2}(?:\1[0-9]{2}){3})(?![0-9])/g;

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
    if (MENTIONS_COLLECTIVES.has(forme.toLowerCase())) collectives += 1;
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
