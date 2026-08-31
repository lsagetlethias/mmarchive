/**
 * Table d identites de substitution, construite une fois pour toute l archive.
 *
 * C est le seul tampon global que la commande s autorise : il est borne par le
 * nombre de comptes, jamais par le nombre de messages. Tout le reste se fait en
 * flux.
 *
 * Trois valeurs par compte plutot qu une, parce que trois lecteurs differents
 * lisent trois champs differents et qu une valeur unique ne peut pas satisfaire
 * les trois formes.
 *
 * `uid` remplace l identifiant technique et garde ses 26 caracteres [a-z0-9] :
 * le format impose cette forme, et un identifiant lisible la ferait echouer
 * partout ou une archive est relue.
 *
 * `username` recoit la forme minuscule. La colonne username de l index n a pas
 * de COLLATE, donc la recherche `from:` y est sensible a la casse : une forme
 * capitalisee ne repondrait qu a la graphie exacte, en echec silencieux.
 *
 * `pseudonyme` porte la forme lisible, et va dans les champs d affichage.
 */
import { randomBytes } from "node:crypto";
import { MM_ID_LENGTH } from "@mmarchive/shared";
import { assignPseudonyms } from "./pseudonym.js";

export interface Identite {
  /** Identifiant technique de substitution, meme forme qu un identifiant Mattermost. */
  readonly uid: string;
  /** Forme lisible, pour les champs d affichage. */
  readonly pseudonyme: string;
  /** Forme minuscule, pour le champ username et les mentions. */
  readonly username: string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Plus grand multiple de 36 tenant dans un octet. Les valeurs au dela sont
 * retirees plutot que repliees : un simple modulo rendrait les quatre premieres
 * lettres plus frequentes que les autres.
 */
const SEUIL_REJET = 252;

function identifiantOpaque(): string {
  let out = "";
  while (out.length < MM_ID_LENGTH) {
    for (const octet of randomBytes(MM_ID_LENGTH)) {
      if (octet >= SEUIL_REJET) continue;
      out += ALPHABET[octet % ALPHABET.length];
      if (out.length === MM_ID_LENGTH) break;
    }
  }
  return out;
}

/**
 * Identifiants tires au hasard, jamais derives de l identifiant d origine.
 *
 * Une derivation, meme salee, laisserait une correspondance reconstituable par
 * qui retrouverait le sel. Un tirage n a rien a retrouver. La contrepartie est
 * qu il faut garantir l unicite au lieu de la deduire : deux comptes qui
 * partageraient un identifiant verraient leurs propos fusionner, et l index les
 * refuserait de toute facon puisque la colonne porte un UNIQUE.
 */
export function buildIdentityTable(userIds: Iterable<string>): Map<string, Identite> {
  const pseudonymes = assignPseudonyms(userIds);
  const pris = new Set<string>();
  const table = new Map<string, Identite>();

  for (const [id, pseudonyme] of pseudonymes) {
    let uid = identifiantOpaque();
    while (pris.has(uid)) uid = identifiantOpaque();
    pris.add(uid);
    table.set(id, { uid, pseudonyme, username: pseudonyme.toLowerCase() });
  }
  return table;
}
