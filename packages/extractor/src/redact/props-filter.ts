/**
 * Reduction de `post.props` a ce qu on sait justifier.
 *
 * `props` est declare `z.record(z.string(), z.unknown())` : le schema ne
 * contraint rien de son contenu, qui depend des plugins installes sur
 * l instance. Il est present sur 62 % des messages de l archive de reference.
 *
 * La regle est une LISTE BLANCHE, et ce n est pas une precaution de style. Sur
 * l archive de reference, la cle `attendents`, mal orthographiee par un plugin
 * de reunion, porte seize noms de comptes ; et `ended_by` est polymorphe, elle
 * porte un identifiant dans trois cas et un nom de compte dans sept. Aucune
 * liste noire ecrite a l avance n aurait attrape ni l une ni l autre.
 *
 * Tout ce qui n est pas nomme ici tombe.
 */
import type { Identite } from "./identity-table.js";
import { type CompteursTexte, reecrireFormesAncrees } from "./text-rewrite.js";

/** Marqueurs de provenance, sans identite et lus par des lecteurs d archive. */
const DRAPEAUX = new Set([
  "from_webhook",
  "from_bot",
  "from_plugin",
  "disable_group_highlight",
  "remove_link_preview",
]);

/** Cles dont la valeur est un identifiant de compte. */
const REFERENCES_ID = new Set(["userId", "addedUserId", "removedUserId", "created_by"]);

/** Cles dont la valeur est un nom de compte. */
const REFERENCES_USERNAME = new Set(["username", "addedUsername", "removedUsername"]);

/** Tableau d identifiants de comptes. */
const REFERENCES_LISTE_ID = new Set(["participants"]);

/**
 * Cle qui porte tantot un identifiant, tantot un nom. Le traitement regarde la
 * valeur et non la cle, seule facon de ne pas se tromper une fois sur deux.
 */
const REFERENCES_POLYMORPHES = new Set(["ended_by"]);

/**
 * Champs d un bloc `attachments` conserves.
 *
 * Ce sont les porteurs de texte : sur l archive de reference, 312 183 messages
 * ont un champ `message` vide et tout leur corps ici. Les vider reviendrait a
 * effacer 16,5 % du corpus au motif que le viewer d aujourd hui ne les affiche
 * pas, alors que c est l archive qui est la donnee durable, pas le viewer.
 *
 * Ce texte porte encore des noms, et ce n est pas cette passe qui les traite :
 * il rejoint le corps des messages, dans le lot de la reecriture de texte.
 *
 * Ce qui n y figure pas tombe, et deux absences sont deliberees. `author_name`
 * designe une personne dans la plupart de ses 123 234 occurrences. Les champs en
 * `_link`, `_url` et `_icon` portent des adresses internes qui nomment
 * l organisation source ou un profil sur un service tiers, ce qu on retire par
 * ailleurs de `manifest.source.url`.
 */
const ATTACHMENT_TEXTE = new Set(["fallback", "text", "title", "pretext", "footer", "color", "ts"]);

/** Un `field` est une paire libelle/valeur affichee sous le corps du bloc. */
const CHAMPS_FIELD = new Set(["title", "value", "short"]);

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
}

export interface ResolveurIdentite {
  parId(id: string): Identite | undefined;
  parUsername(username: string): Identite | undefined;
  /**
   * Vrai si cette valeur est un nom de substitution deja emis.
   *
   * Sert a la reecriture du texte : une passe anterieure a deja substitue des
   * noms dans les messages systeme, et sans ce test la passe suivante les
   * prendrait pour des mentions non resolues et les neutraliserait. C est ce
   * qui rend la reecriture idempotente.
   */
  estSubstitution(nom: string): boolean;
  /** Identifiant de substitution d un identifiant d origine, s il en designe un. */
  uidPourIdentifiant(id: string): string | undefined;
}

/** Ce qu une reduction a retire, pour que le resume de la commande le dise. */
export interface CompteursProps {
  /** Cles retirees faute d etre nommees par la liste blanche. */
  clesRetirees: number;
  /** References reecrites vers une identite de substitution. */
  referencesReecrites: number;
  /**
   * References retirees faute de resoudre vers un compte.
   *
   * Ce cas est reel et non theorique : sur l archive de reference, 151
   * identifiants de `addedUserId` et `removedUserId` ne correspondent a aucune
   * fiche, parce que le compte a ete supprime de l instance ou que sa
   * recuperation a echoue. Les conserver laisserait des identifiants reels dans
   * une archive presentee comme anonyme.
   */
  referencesOrphelines: number;
  /** Blocs d attachment reduits a leurs seuls porteurs de texte. */
  attachmentsReduits: number;
}

export function compteursPropsVides(): CompteursProps {
  return {
    clesRetirees: 0,
    referencesReecrites: 0,
    referencesOrphelines: 0,
    attachmentsReduits: 0,
  };
}

/**
 * Reecrit une valeur conservee, si c est du texte.
 *
 * La reecriture se fait ICI et non dans une passe separee : ce module est le
 * seul a connaitre la liste blanche des champs conserves, et cette liste a deja
 * bouge deux fois. Une passe separee en tiendrait une copie, qui divergerait au
 * prochain ajustement, et un champ ajoute a la liste blanche serait conserve
 * sans etre reecrit sans que personne ne le voie.
 */
function valeurReecrite(
  valeur: unknown,
  resolveur: ResolveurIdentite,
  texte: CompteursTexte,
): unknown {
  return typeof valeur === "string" ? reecrireFormesAncrees(valeur, resolveur, texte) : valeur;
}

function reduireField(
  field: unknown,
  resolveur: ResolveurIdentite,
  texte: CompteursTexte,
): Record<string, unknown> | undefined {
  if (!estObjet(field)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(field)) {
    if (CHAMPS_FIELD.has(cle)) out[cle] = valeurReecrite(valeur, resolveur, texte);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function reduireAttachment(
  bloc: unknown,
  resolveur: ResolveurIdentite,
  texte: CompteursTexte,
): Record<string, unknown> | undefined {
  if (!estObjet(bloc)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(bloc)) {
    if (ATTACHMENT_TEXTE.has(cle)) out[cle] = valeurReecrite(valeur, resolveur, texte);
  }
  const fields = bloc.fields;
  if (Array.isArray(fields)) {
    const gardes = fields
      .map((field) => reduireField(field, resolveur, texte))
      .filter((f) => f !== undefined);
    if (gardes.length > 0) out.fields = gardes;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Rend `props` reduit a la liste blanche, references reecrites.
 *
 * Une reference qui ne resout pas est RETIREE, jamais conservee. C est le sens
 * de la promesse : mieux vaut une metadonnee manquante qu un identifiant reel
 * qui survit parce que personne n a su a qui il appartenait.
 */
export function reduireProps(
  props: Record<string, unknown>,
  resolveur: ResolveurIdentite,
  compteurs: CompteursProps,
  // Obligatoire, jamais optionnel : un futur appelant doit trancher plutot
  // qu heriter d un defaut qui laisserait du texte non reecrit.
  texte: CompteursTexte,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [cle, valeur] of Object.entries(props)) {
    if (DRAPEAUX.has(cle)) {
      out[cle] = valeur;
      continue;
    }

    if (cle === "attachments") {
      if (Array.isArray(valeur)) {
        const gardes = valeur
          .map((bloc) => reduireAttachment(bloc, resolveur, texte))
          .filter((b) => b !== undefined);
        compteurs.attachmentsReduits += gardes.length;
        if (gardes.length > 0) out[cle] = gardes;
        else compteurs.clesRetirees += 1;
      } else {
        compteurs.clesRetirees += 1;
      }
      continue;
    }

    if (REFERENCES_LISTE_ID.has(cle)) {
      if (!Array.isArray(valeur)) {
        compteurs.clesRetirees += 1;
        continue;
      }
      const resolus: string[] = [];
      for (const element of valeur) {
        const identite = typeof element === "string" ? resolveur.parId(element) : undefined;
        if (identite === undefined) compteurs.referencesOrphelines += 1;
        else {
          resolus.push(identite.uid);
          compteurs.referencesReecrites += 1;
        }
      }
      out[cle] = resolus;
      continue;
    }

    if (REFERENCES_ID.has(cle) || REFERENCES_USERNAME.has(cle) || REFERENCES_POLYMORPHES.has(cle)) {
      if (typeof valeur !== "string") {
        compteurs.clesRetirees += 1;
        continue;
      }
      const parId = REFERENCES_USERNAME.has(cle) ? undefined : resolveur.parId(valeur);
      const identite =
        parId ?? (REFERENCES_ID.has(cle) ? undefined : resolveur.parUsername(valeur));
      if (identite === undefined) {
        compteurs.referencesOrphelines += 1;
        continue;
      }
      out[cle] = parId === undefined ? identite.username : identite.uid;
      compteurs.referencesReecrites += 1;
      continue;
    }

    compteurs.clesRetirees += 1;
  }

  return out;
}

/**
 * Positions de `props` qui portent une reference a un compte.
 *
 * Le controle residuel s en sert pour savoir ou verifier, plutot que de chercher
 * un motif d identifiant partout : les identifiants de messages, de canaux et de
 * pieces jointes ont exactement la meme forme et sont conserves volontairement.
 */
export const PROPS_POSITIONS_REFERENCE = {
  identifiant: REFERENCES_ID,
  nom: REFERENCES_USERNAME,
  liste: REFERENCES_LISTE_ID,
  polymorphe: REFERENCES_POLYMORPHES,
} as const;
