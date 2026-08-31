/**
 * Pseudonymes lisibles et manifestement artificiels.
 *
 * Trois exigences, dans cet ordre.
 *
 * **Irreversible.** L identifiant est hache avec un sel tire au hasard a chaque
 * execution, puis jete. Sans sel, un simple `sha256(user_id)` se renverse en
 * quelques secondes par qui possede la liste des identifiants de l instance,
 * c est a dire exactement le public dont on cherche a se proteger.
 *
 * **Impossible a confondre avec quelqu un.** Un generateur de noms realistes
 * attribuerait a coup sur des identites existantes : sur l archive de reference,
 * trente prenoms francais tres courants sont tous deja portes par un compte.
 * Prendre les propos d une personne pour les attribuer au nom d une autre est
 * pire que de ne pas anonymiser.
 *
 * La forme nom plus adjectif n y suffisait pas. Mesure sur ce vocabulaire :
 * 868 combinaisons sur 5 050 se lisent comme une identite, « Jade Humble » ou
 * « Ambre Fertile », parce que plusieurs noms de choses sont aussi des prenoms.
 * Ecarter ces mots un par un reviendrait a tenir une liste de prenoms, c est a
 * dire a se tromper un jour sur un prenom rare. Le prefixe `Anon-` regle la
 * question par la forme : aucun etat civil ne s ecrit ainsi, et le lecteur le
 * voit a chaque ligne au lieu de l oublier au bout de dix minutes.
 *
 * **Unique.** Deux personnes ne doivent jamais partager un pseudonyme, sans quoi
 * leurs propos fusionnent. Le tirage au hasard ne suffit pas : sur trois mille
 * personnes et quelques milliers de combinaisons, les collisions sont certaines.
 * Les pseudonymes sont donc distribues, pas tires.
 */
import { createHash, randomBytes } from "node:crypto";

interface Nom {
  readonly mot: string;
  readonly feminin: boolean;
}

/**
 * Choses, jamais personnes. Ni metier, ni titre, ni toponyme : ce sont les
 * gisements de patronymes.
 */
const NOMS: readonly Nom[] = [
  { mot: "Basalte", feminin: false },
  { mot: "Quartz", feminin: false },
  { mot: "Granite", feminin: false },
  { mot: "Ardoise", feminin: true },
  { mot: "Obsidienne", feminin: true },
  { mot: "Ambre", feminin: false },
  { mot: "Onyx", feminin: false },
  { mot: "Silex", feminin: false },
  { mot: "Marbre", feminin: false },
  { mot: "Opale", feminin: true },
  { mot: "Topaze", feminin: true },
  { mot: "Jade", feminin: false },
  { mot: "Cristal", feminin: false },
  { mot: "Calcaire", feminin: false },
  { mot: "Fougere", feminin: true },
  { mot: "Bruyere", feminin: true },
  { mot: "Cypres", feminin: false },
  { mot: "Roseau", feminin: false },
  { mot: "Genevrier", feminin: false },
  { mot: "Lichen", feminin: false },
  { mot: "Mousse", feminin: true },
  { mot: "Bambou", feminin: false },
  { mot: "Trefle", feminin: false },
  { mot: "Lavande", feminin: true },
  { mot: "Sureau", feminin: false },
  { mot: "Erable", feminin: false },
  { mot: "Bouleau", feminin: false },
  { mot: "Chataigne", feminin: true },
  { mot: "Alouette", feminin: true },
  { mot: "Mesange", feminin: true },
  { mot: "Pinson", feminin: false },
  { mot: "Fauvette", feminin: true },
  { mot: "Hirondelle", feminin: true },
  { mot: "Grive", feminin: true },
  { mot: "Sarcelle", feminin: true },
  { mot: "Cormoran", feminin: false },
  { mot: "Goeland", feminin: false },
  { mot: "Guillemot", feminin: false },
  { mot: "Loutre", feminin: true },
  { mot: "Belette", feminin: true },
  { mot: "Hermine", feminin: true },
  { mot: "Blaireau", feminin: false },
  { mot: "Renard", feminin: false },
  { mot: "Chevreuil", feminin: false },
  { mot: "Sanglier", feminin: false },
  { mot: "Marmotte", feminin: true },
  { mot: "Ecureuil", feminin: false },
  { mot: "Herisson", feminin: false },
  { mot: "Comete", feminin: true },
  { mot: "Nebuleuse", feminin: true },
  { mot: "Meteore", feminin: false },
  { mot: "Aurore", feminin: true },
  { mot: "Mousson", feminin: true },
  { mot: "Embrun", feminin: false },
  { mot: "Brume", feminin: true },
  { mot: "Givre", feminin: false },
  { mot: "Orage", feminin: false },
  { mot: "Nuage", feminin: false },
  { mot: "Cascade", feminin: true },
  { mot: "Torrent", feminin: false },
  { mot: "Estuaire", feminin: false },
  { mot: "Lagune", feminin: true },
  { mot: "Recif", feminin: false },
  { mot: "Dune", feminin: true },
  { mot: "Falaise", feminin: true },
  { mot: "Glacier", feminin: false },
  { mot: "Boussole", feminin: true },
  { mot: "Sextant", feminin: false },
  { mot: "Horloge", feminin: true },
  { mot: "Lanterne", feminin: true },
  { mot: "Balise", feminin: true },
  { mot: "Ancre", feminin: true },
  { mot: "Gouvernail", feminin: false },
  { mot: "Cordage", feminin: false },
  { mot: "Voilure", feminin: true },
  { mot: "Carene", feminin: true },
  { mot: "Prisme", feminin: false },
  { mot: "Pendule", feminin: false },
  { mot: "Alambic", feminin: false },
  { mot: "Creuset", feminin: false },
  { mot: "Enclume", feminin: true },
  { mot: "Soufflet", feminin: false },
  { mot: "Rabot", feminin: false },
  { mot: "Ciseau", feminin: false },
  { mot: "Navette", feminin: true },
  { mot: "Bobine", feminin: true },
  { mot: "Grelot", feminin: false },
  { mot: "Tambour", feminin: false },
  { mot: "Cithare", feminin: true },
  { mot: "Flute", feminin: true },
  { mot: "Vielle", feminin: true },
  { mot: "Cymbale", feminin: true },
  { mot: "Losange", feminin: false },
  { mot: "Spirale", feminin: true },
  { mot: "Ellipse", feminin: true },
  { mot: "Vecteur", feminin: false },
  { mot: "Fractale", feminin: true },
  { mot: "Meridien", feminin: false },
  { mot: "Parallele", feminin: false },
  { mot: "Zenith", feminin: false },
  { mot: "Sillage", feminin: false },
];

/** Adjectifs dans leurs deux formes, pour que l accord soit correct. */
const ADJECTIFS: readonly (readonly [string, string])[] = [
  ["Agile", "Agile"],
  ["Ample", "Ample"],
  ["Calme", "Calme"],
  ["Celeste", "Celeste"],
  ["Discret", "Discrete"],
  ["Fertile", "Fertile"],
  ["Fidele", "Fidele"],
  ["Franc", "Franche"],
  ["Furtif", "Furtive"],
  ["Grave", "Grave"],
  ["Habile", "Habile"],
  ["Humble", "Humble"],
  ["Limpide", "Limpide"],
  ["Lucide", "Lucide"],
  ["Mobile", "Mobile"],
  ["Nomade", "Nomade"],
  ["Paisible", "Paisible"],
  ["Patient", "Patiente"],
  ["Placide", "Placide"],
  ["Prudent", "Prudente"],
  ["Rapide", "Rapide"],
  ["Robuste", "Robuste"],
  ["Sobre", "Sobre"],
  ["Solide", "Solide"],
  ["Souple", "Souple"],
  ["Stable", "Stable"],
  ["Subtil", "Subtile"],
  ["Tenace", "Tenace"],
  ["Tranquille", "Tranquille"],
  ["Vaillant", "Vaillante"],
  ["Vif", "Vive"],
  ["Serein", "Sereine"],
  ["Sonore", "Sonore"],
  ["Lointain", "Lointaine"],
  ["Profond", "Profonde"],
  ["Clair", "Claire"],
  ["Dense", "Dense"],
  ["Leger", "Legere"],
  ["Vaste", "Vaste"],
  ["Droit", "Droite"],
  ["Adroit", "Adroite"],
  ["Constant", "Constante"],
  ["Loyal", "Loyale"],
  ["Sagace", "Sagace"],
  ["Alerte", "Alerte"],
  ["Serieux", "Serieuse"],
  ["Curieux", "Curieuse"],
  ["Soigneux", "Soigneuse"],
  ["Attentif", "Attentive"],
  ["Pensif", "Pensive"],
];

/**
 * Marque tout pseudonyme comme tel.
 *
 * Sans elle, une combinaison sur six se lit comme un nom de personne. Avec elle,
 * aucune ne le peut : c est une garantie de forme, pas une liste de mots a
 * maintenir a jour.
 */
export const PREFIXE = "Anon-";

/** Combinaisons distinctes que ce vocabulaire peut former. */
export const CAPACITE = NOMS.length * ADJECTIFS.length;

/**
 * Forme exacte d un pseudonyme emis.
 *
 * Le controle residuel s en sert plutot que de chercher un nom d etat civil dans
 * la valeur, et la raison est mesuree : trois mots de ce vocabulaire,
 * « Claire », « Guillemot » et « Leger », sont aussi des noms portes par des
 * comptes de l archive de reference. Deux pour cent du vocabulaire suffisaient a
 * faire signaler 101 comptes sur 3 277 comme portant une identite survivante,
 * alors qu ils portaient leur propre pseudonyme.
 *
 * C est le meme fait qui justifie le prefixe : « Guillemot Adroit » se lirait
 * comme un nom de personne, et se trouve en etre un.
 */
export const FORME_PSEUDONYME = /^Anon-[A-Z][a-z]+-[A-Z][a-z]+(?:-\d+)?$/;

function combinaison(rang: number): string {
  // Les deux axes avancent ensemble, et leurs tailles sont premieres entre elles
  // pour que le cycle couvre bien toutes les combinaisons. Faire avancer
  // l adjectif seulement apres un tour complet des noms donnerait le meme
  // adjectif a tout le monde sur une petite archive, ce qui se lit mal et
  // n apporte rien.
  const nom = NOMS[rang % NOMS.length];
  const adjectif = ADJECTIFS[rang % ADJECTIFS.length];
  if (nom === undefined || adjectif === undefined) {
    throw new Error("Rang hors du vocabulaire disponible.");
  }
  const accorde = nom.feminin ? adjectif[1] : adjectif[0];
  const tour = Math.floor(rang / CAPACITE);
  // Au dela du vocabulaire, un numero plutot qu un mot invente : mieux vaut un
  // pseudonyme un peu lourd qu une collision qui fondrait deux personnes en une.
  const suffixe = tour === 0 ? "" : `-${String(tour + 1)}`;
  return `${PREFIXE}${nom.mot}-${accorde}${suffixe}`;
}

/**
 * Distribue un pseudonyme unique a chaque identifiant.
 *
 * L ordre de distribution suit le hachage sale, pas l ordre des identifiants :
 * une distribution qui suivrait l ordre naturel se rejouerait par quiconque
 * possede la liste des comptes, et le sel ne servirait plus a rien.
 *
 * Le sel n est jamais rendu. Le conserver permettrait de refaire la
 * correspondance, ce qui priverait l archive de son caractere anonyme, et ce
 * fichier deviendrait la chose a ne surtout pas perdre.
 */
export function assignPseudonyms(userIds: Iterable<string>): Map<string, string> {
  const sel = randomBytes(32);
  const classes = [...new Set(userIds)]
    .map((id) => ({
      id,
      rang: createHash("sha256").update(sel).update(id).digest("hex"),
    }))
    .sort((a, b) => (a.rang < b.rang ? -1 : a.rang > b.rang ? 1 : 0));

  return new Map(classes.map(({ id }, index) => [id, combinaison(index)]));
}
