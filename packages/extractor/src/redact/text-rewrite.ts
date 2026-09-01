/**
 * Reecriture des formes ancrees dans le texte : mentions, adresses, telephones,
 * identifiants colles.
 *
 * PAS le remplacement des noms ecrits en clair, qui est l etape suivante et
 * demande une prudence que celle-ci n a pas besoin d avoir. Toute la surete de
 * ce module vient de l ancrage : une mention commence par un arobase, une
 * adresse porte un arobase et un domaine, un identifiant fait vingt-six
 * caracteres. Rien n est devine a partir d un mot ordinaire.
 *
 * UNE SEULE passe, une alternation ordonnee, un callback qui branche sur le
 * groupe capture. Ce n est pas un choix de style et quatre `replace` chaines ne
 * feraient pas la meme chose : le texte rendu par un callback n est jamais relu
 * par le moteur, alors qu une passe suivante relirait ce que la precedente a
 * ecrit. Or les valeurs injectees sont tirees des alphabets memes que les
 * detecteurs lisent. L identifiant de substitution fait vingt-six caracteres
 * [a-z0-9], exactement ce que cherche le detecteur d identifiants ; le nom de
 * substitution est un corps de mention valide et une partie locale d adresse
 * valide. Enchainer les passes ne peut donc pas etre idempotent, quel que soit
 * l ordre choisi.
 */
import {
  ADRESSE_MENTION,
  CORPS_MENTION,
  estMentionCollective,
  LOCAL_ADRESSE,
  TELEPHONE_INTERNATIONAL,
  TELEPHONE_NATIONAL,
} from "./measure.js";
import { normaliserForme } from "./name-vocabulary.js";
import type { ResolveurIdentite } from "./props-filter.js";

/**
 * Substituts sans arobase, sans domaine, sans chiffre et sans caractere de
 * balisage.
 *
 * Le choix de la forme n est pas cosmetique. `<redacted>` serait relu par le
 * rendu markdown du viewer : le chevron coupe le lien la ou il est pose, donc
 * une adresse remplacee au milieu d une URL laisse un lien tronque et le reste
 * de l URL en clair a cote, et `[Alice](mailto:<redacted>)` produit un lien de
 * contact cliquable. 2 861 adresses de l archive de reference vivent dans une
 * destination de lien markdown.
 *
 * Ces substituts sont par ailleurs invisibles aux quatre detecteurs, ce qui
 * garantit qu une seconde lecture ne les reprend pas.
 */
export const ADRESSE_RETIREE = "adresse-retiree";
export const TELEPHONE_RETIRE = "numero-retire";
export const MENTION_RETIREE = "mention-retiree";

/** Ce qu une reecriture a fait, par forme. Jamais fondu en un seul chiffre. */
export interface CompteursTexte {
  mentionsSubstituees: number;
  /** Deja pseudonymisees en amont, rendues inchangees. */
  mentionsDejaTraitees: number;
  mentionsNeutralisees: number;
  mentionsCollectives: number;
  adressesRetirees: number;
  telephonesRetires: number;
  identifiantsSubstitues: number;
  /**
   * Jetons de vingt-six caracteres qui ne designent aucun compte.
   *
   * Rendus INCHANGES, et c est une decision mesuree. La regle qui vaut dans les
   * metadonnees, une reference qui ne resout vers rien est retiree, serait
   * catastrophique ici : sur les corps de l archive de reference, 10 534 jetons
   * de cette forme, dont 11 sont des comptes et 6 566 des permaliens que le
   * format conserve deliberement. La regle negative en detruirait 10 523 pour en
   * traiter 11. Ce residu est indecidable et se compte comme tel.
   */
  identifiantsIndecidables: number;
  /**
   * Noms ecrits en clair remplaces.
   *
   * Compte a part des mentions : une mention est ancree et sure, un nom en clair
   * ne l est pas, et fondre les deux masquerait le seul chiffre qui dit combien
   * de texte a ete pris au risque de l abimer.
   */
  nomsRemplaces: number;
}

export function compteursTexteVides(): CompteursTexte {
  return {
    mentionsSubstituees: 0,
    mentionsDejaTraitees: 0,
    mentionsNeutralisees: 0,
    mentionsCollectives: 0,
    adressesRetirees: 0,
    telephonesRetires: 0,
    identifiantsSubstitues: 0,
    identifiantsIndecidables: 0,
    nomsRemplaces: 0,
  };
}

/**
 * L alternation, dans l ordre qui decide.
 *
 * `@local@domaine` en tete parce qu aucun ordre generique ne la traite bien.
 * L adresse ensuite, avant l identifiant, parce que des identifiants de
 * vingt-six caracteres sont des parties locales d adresse et qu une passe
 * identifiant les mutilerait avant qu on reconnaisse l adresse ; et avant la
 * mention, parce que c est le seul endroit ou l ordre decide d une fuite et non
 * d un simple degat de texte. La mention en dernier : sa classe de corps est la
 * plus permissive des quatre, elle mordrait dans tout ce que les autres n ont
 * pas encore consomme.
 */
const DOMAINE = String.raw`[\p{L}\p{N}.-]+\.[\p{L}]{2,}`;

const FORMES: RegExp = new RegExp(
  [
    // Ancree a gauche comme les autres, et le domaine est repetable. Deux
    // corrections qu un seul message de l archive de reference a revelees, en
    // portant la forme `alice@domaine.fr@suite.org`. Sans ancrage a gauche,
    // cette alternative mord au milieu et capture `@domaine.fr@suite.org` ;
    // sans repetition, la premiere adresse est consommee et le substitut se
    // recolle au reste, `adresse-retiree@suite.org` etant encore une adresse.
    // Le moteur ne relit pas ce qu il vient d ecrire, donc rien ne rattrape.
    String.raw`(?<adresseMention>(?<![\p{L}\p{N}._%+-])@${LOCAL_ADRESSE}(?:@${DOMAINE})+(?![\p{L}\p{N}]))`,
    String.raw`(?<adresse>${LOCAL_ADRESSE}(?:@${DOMAINE})+(?![\p{L}\p{N}]))`,
    String.raw`(?<identifiant>(?<![\p{L}\p{N}])[a-z0-9]{26}(?![\p{L}\p{N}]))`,
    // Motifs partages avec les detecteurs, references NOMMEES : une position
    // numerique se decalerait au premier ajout de forme dans l alternation.
    String.raw`(?<telephone>(?<![\p{L}\p{M}\p{N}_])(?:${TELEPHONE_INTERNATIONAL}|${TELEPHONE_NATIONAL})(?![\p{L}\p{M}\p{N}_]))`,
    String.raw`(?<mention>(?<![\p{L}\p{N}_%+])@(?:${CORPS_MENTION}))`,
  ].join("|"),
  "gu",
);

/**
 * La meme alternation, plus une branche qui capture tout mot assez long.
 *
 * Le remplacement des noms rejoint l alternation au lieu de passer apres, pour
 * la meme raison que tout le reste : le texte rendu par le callback n est jamais
 * relu. Une passe posterieure pourrait remanger un mot du pseudonyme injecte,
 * « Anon-Obsidienne-Discrete » etant fait de mots ordinaires.
 *
 * La branche capture largement et c est le callback qui decide, plutot qu une
 * alternation de deux mille cinq cents formes que le moteur devrait essayer a
 * chaque position.
 */
const FORMES_AVEC_NOMS = new RegExp(
  `${FORMES.source}|(?<nom>(?<![\\p{L}\\p{M}\\p{N}_-])[\\p{L}\\p{M}]{4,}(?![\\p{L}\\p{M}\\p{N}_-]))`,
  "gu",
);

/** Ponctuation finale, que Mattermost retire lui-meme avant de resoudre. */
function separerPonctuation(forme: string): { nom: string; fin: string } {
  const nom = forme.replace(/\.+$/, "");
  return { nom, fin: forme.slice(nom.length) };
}

function substituerMention(
  forme: string,
  resolveur: ResolveurIdentite,
  compteurs: CompteursTexte,
): string {
  const { nom, fin } = separerPonctuation(forme);
  if (estMentionCollective(nom)) {
    // Elles ne designent personne. Sans cette branche elles tomberaient dans la
    // neutralisation, ce qui abimerait 3 584 messages pour zero identite.
    compteurs.mentionsCollectives += 1;
    return `@${forme}`;
  }
  const identite = resolveur.parUsername(nom);
  if (identite !== undefined) {
    compteurs.mentionsSubstituees += 1;
    return `@${identite.username}${fin}`;
  }
  // Une forme qui EST deja un nom de substitution se rend inchangee. Sans ce
  // test, cette passe defait celle des messages systeme, qui a substitue 16 422
  // mentions en amont : elles paraitraient orphelines et seraient neutralisees,
  // et la destruction se lirait comme du travail utile.
  if (resolveur.estSubstitution(nom)) {
    compteurs.mentionsDejaTraitees += 1;
    return `@${forme}`;
  }
  // Une mention non resolue reste un nom.
  compteurs.mentionsNeutralisees += 1;
  return MENTION_RETIREE;
}

/**
 * Rend le texte, formes ancrees traitees.
 *
 * Pure : ni etat, ni lecture de fichier. Le meme texte donne toujours le meme
 * resultat, et le resultat repasse dans cette fonction ne bouge plus.
 */
export function reecrireFormesAncrees(
  texte: string,
  resolveur: ResolveurIdentite,
  compteurs: CompteursTexte,
  /**
   * Vocabulaire des noms ecrits en clair, absent aux niveaux qui n y touchent
   * pas. Explicite : son absence veut dire « ne pas remplacer les noms ».
   */
  noms?: ReadonlyMap<string, string>,
): string {
  if (texte === "") return texte;
  return texte.replace(noms === undefined ? FORMES : FORMES_AVEC_NOMS, (trouve, ...args) => {
    const groupes = args.at(-1) as Record<string, string | undefined>;

    if (groupes["adresseMention"] !== undefined) {
      const local = ADRESSE_MENTION.exec(trouve)?.[1] ?? "";
      const identite = resolveur.parUsername(local);
      if (identite !== undefined) {
        // Le compte est connu : on garde le fil et on jette le domaine.
        compteurs.mentionsSubstituees += 1;
        return `@${identite.username}`;
      }
      compteurs.adressesRetirees += 1;
      return ADRESSE_RETIREE;
    }

    if (groupes["adresse"] !== undefined) {
      compteurs.adressesRetirees += 1;
      return ADRESSE_RETIREE;
    }

    if (groupes["identifiant"] !== undefined) {
      const uid = resolveur.uidPourIdentifiant(trouve);
      if (uid === undefined) {
        compteurs.identifiantsIndecidables += 1;
        return trouve;
      }
      compteurs.identifiantsSubstitues += 1;
      return uid;
    }

    if (groupes["telephone"] !== undefined) {
      compteurs.telephonesRetires += 1;
      return TELEPHONE_RETIRE;
    }

    if (groupes["nom"] !== undefined) {
      const substitut = noms?.get(normaliserForme(trouve));
      if (substitut === undefined) return trouve;
      compteurs.nomsRemplaces += 1;
      return substitut;
    }

    return substituerMention(trouve.slice(1), resolveur, compteurs);
  });
}
