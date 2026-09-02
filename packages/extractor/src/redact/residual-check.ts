/**
 * Controle de ce qui a survecu, relu sur l archive produite.
 *
 * C est la seule vraie securite de l anonymisation, et il faut dire pourquoi :
 * `mmarchive-verify` ne verifie rien de l anonymat. Il ne confronte jamais
 * `reactions[].user_id`, `files.user_id` ni `emojis.creator_id` a l annuaire, il
 * ne regarde jamais `props`, et son controle des binaires ne parcourt que
 * `files.ndjson`, donc ignore les avatars. Une archive dont les 433 442
 * reactions auraient garde leurs identifiants reels passerait la verification
 * sans un seul avertissement.
 *
 * Le controle est POSITIF sur les references : une valeur en position de
 * reference doit appartenir a l ensemble des identifiants de substitution. Le
 * formuler en negatif, en cherchant les identifiants d origine, laisserait
 * passer ceux qui ne resolvaient vers aucun compte, c est a dire exactement les
 * plus faciles a oublier. Il est negatif, en complement, sur les champs dont la
 * commande pretend qu ils sont nettoyes.
 *
 * Ce qu il NE couvre pas est enumere par `horsControle` et rendu a l appelant
 * pour qu il l affiche : un controle qui tairait ses limites serait pire que pas
 * de controle, puisqu il ferait croire l archive diffusable.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARCHIVE_LAYOUT,
  type ArchiveChannel,
  type ArchiveEmoji,
  type ArchiveFile,
  type ArchivePost,
  type ArchiveUser,
  ERROR_CODES,
  type ErrorCode,
  type Manifest,
} from "@mmarchive/shared";
import { readNdjson } from "@mmarchive/shared/ndjson";
import { createArchivePaths } from "../archive/paths.js";
import { adressesDe, identifiantsDe, mentionsDe, telephonesDe } from "./measure.js";
import { type NiveauAnonymisation, reecritLesFormes, reecritLesNoms } from "./niveau.js";
import { PROPS_POSITIONS_REFERENCE } from "./props-filter.js";
import { FORME_PSEUDONYME } from "./pseudonym.js";
import {
  type CanalCandidat,
  type FormeResiduelle,
  type MesuresSortie,
  mesuresVides,
  PLAFOND_IDENTIFIANTS_COLLES,
} from "./report-data.js";

export class ResidualIdentityError extends Error {
  readonly code: ErrorCode = ERROR_CODES.ResidualIdentityError;
  constructor(message: string) {
    super(message);
    this.name = "ResidualIdentityError";
  }
}

export interface Manquement {
  readonly emplacement: string;
  readonly champ: string;
  readonly genre: "reference-inconnue" | "identite-survivante";
  /** Borne a quelques caracteres : ce rapport ne doit pas devenir la fuite. */
  readonly extrait: string;
}

export interface IdentitesOrigine {
  readonly ids: ReadonlySet<string>;
  /** En minuscules. */
  readonly usernames: ReadonlySet<string>;
  /** Prenoms, noms, surnoms et formes concatenees, en minuscules. */
  readonly noms: ReadonlySet<string>;
  /** Nombre de comptes portant chaque forme. Un ou deux designe quelqu un. */
  readonly porteurs: ReadonlyMap<string, number>;
  /**
   * Formes assez longues pour etre cherchees a l interieur d un texte.
   *
   * Un compte de l archive de reference porte le nom d utilisateur « r ».
   * Cherche mot a mot, il correspond a toute lettre isolee, et signalait le
   * libelle « piece-jointe-24262.r » dont le « r » est l extension d un script.
   * Les formes courtes restent comparees a la valeur entiere, jamais a ses mots :
   * un champ qui vaut exactement « r » est toujours signale.
   */
  readonly motsRecherchables: ReadonlySet<string>;
}

export interface Substitution {
  readonly uids: ReadonlySet<string>;
  readonly usernames: ReadonlySet<string>;
}

export interface ResidualReport {
  readonly referencesVerifiees: number;
  readonly valeursVerifiees: number;
  readonly manquements: readonly Manquement[];
  /** Ce que ce controle ne peut pas garantir, a afficher tel quel. */
  readonly horsControle: readonly string[];
  /** Mesures faites au passage, sur l archive produite. */
  readonly mesures: MesuresSortie;
}

/** Un nom plus court se confond avec des mots ordinaires et noierait le rapport. */
const LONGUEUR_NOM_MINIMALE = 4;

const MOT = /[\p{L}\p{N}]+/gu;

function normaliser(valeur: string): string {
  return valeur
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
}

/**
 * Ensembles construits depuis l annuaire d origine.
 *
 * Les prenoms et noms comptent autant que les identifiants : sur l archive de
 * reference, 215 valeurs de `props` portent un prenom ou un surnom sans
 * correspondre a aucun nom de compte. Un controle qui ne connaitrait que les
 * identifiants declarerait propre une archive qui porte encore de l etat civil.
 */
export function collecterIdentitesOrigine(users: Iterable<ArchiveUser>): IdentitesOrigine {
  const ids = new Set<string>();
  const usernames = new Set<string>();
  const noms = new Set<string>();
  const porteurs = new Map<string, number>();
  for (const user of users) {
    ids.add(user.id);
    if (user.username !== "") usernames.add(normaliser(user.username));
    for (const champ of [user.first_name, user.last_name, user.nickname]) {
      const valeur = normaliser(champ.trim());
      if (valeur.length >= LONGUEUR_NOM_MINIMALE) noms.add(valeur);
    }
    const prenom = normaliser(user.first_name.trim());
    const nom = normaliser(user.last_name.trim());
    if (prenom !== "" && nom !== "") noms.add(`${prenom} ${nom}`);

    // Compte les porteurs de chaque forme : c est ce qui distingue un
    // identifiant rare, qui designe quelqu un, d un prenom repandu employe
    // comme mot ordinaire.
    const formes = new Set<string>();
    if (user.username !== "") formes.add(normaliser(user.username));
    for (const champ of [user.first_name, user.last_name, user.nickname]) {
      const valeur = normaliser(champ.trim());
      if (valeur.length >= LONGUEUR_NOM_MINIMALE) formes.add(valeur);
    }
    for (const forme of formes) porteurs.set(forme, (porteurs.get(forme) ?? 0) + 1);
  }
  const motsRecherchables = new Set(
    [...noms, ...usernames].filter((forme) => forme.length >= LONGUEUR_NOM_MINIMALE),
  );
  return { ids, usernames, noms, motsRecherchables, porteurs };
}

/**
 * Formes d un libelle susceptibles d etre un nom de compte.
 *
 * Les mots seuls ne suffisent pas : un nom d utilisateur Mattermost peut
 * contenir un point ou un tiret, donc un compte nomme « alice-smith » ne serait
 * jamais reconnu dans un canal « alice-smith » si on ne comparait que les mots.
 * La valeur entiere normalisee entre donc aussi dans les candidates.
 */
function formesCandidates(valeur: string): Set<string> {
  const normalisee = normaliser(valeur).trim();
  const candidates = new Set(normalisee.match(MOT) ?? []);
  if (normalisee !== "") candidates.add(normalisee);
  // Une forme composee du libelle, pour les noms ecrits avec un separateur que
  // le decoupage en mots aurait fait disparaitre.
  for (const separateur of ["-", "."]) {
    const segments = normalisee.split(separateur).filter((s) => s !== "");
    if (segments.length > 1) candidates.add(segments.join(separateur));
  }
  return candidates;
}

function extrait(valeur: string): string {
  return valeur.length <= 32 ? valeur : `${valeur.slice(0, 32)}...`;
}

class Collecteur {
  readonly manquements: Manquement[] = [];
  referencesVerifiees = 0;
  valeursVerifiees = 0;

  constructor(
    private readonly origine: IdentitesOrigine,
    private readonly substitution: Substitution,
  ) {}

  /** Le coeur du controle : une reference doit etre l une des nouvelles. */
  reference(emplacement: string, champ: string, valeur: unknown, genre: "uid" | "username"): void {
    if (typeof valeur !== "string" || valeur === "") return;
    this.referencesVerifiees += 1;
    const connues = genre === "uid" ? this.substitution.uids : this.substitution.usernames;
    if (connues.has(valeur)) return;
    this.manquements.push({
      emplacement,
      champ,
      genre: "reference-inconnue",
      extrait: extrait(valeur),
    });
  }

  /**
   * Reference acceptee sous l une ou l autre forme.
   *
   * `ended_by` porte un identifiant dans trois cas et un nom de compte dans
   * sept, sur la meme archive. La controler sur une seule forme signalerait a
   * tort toutes celles qui portent l autre.
   */
  referencePolymorphe(emplacement: string, champ: string, valeur: unknown): void {
    if (typeof valeur !== "string" || valeur === "") return;
    this.referencesVerifiees += 1;
    if (this.substitution.uids.has(valeur) || this.substitution.usernames.has(valeur)) return;
    this.manquements.push({
      emplacement,
      champ,
      genre: "reference-inconnue",
      extrait: extrait(valeur),
    });
  }

  /**
   * Champ d affichage : il doit porter un pseudonyme, verifie sur sa forme.
   *
   * Le controle negatif ne convient pas ici. Une valeur produite par cette
   * commande contient des mots ordinaires du francais, dont certains sont aussi
   * des noms de famille reels : chercher un nom d etat civil dedans signale le
   * pseudonyme lui-meme. Voir FORME_PSEUDONYME.
   */
  pseudonyme(emplacement: string, champ: string, valeur: unknown): void {
    this.valeursVerifiees += 1;
    if (typeof valeur === "string" && FORME_PSEUDONYME.test(valeur)) return;
    this.manquements.push({
      emplacement,
      champ,
      genre: "identite-survivante",
      extrait: extrait(typeof valeur === "string" ? valeur : String(valeur)),
    });
  }

  /** Champ que la commande annonce avoir vide. Non vide vaut manquement. */
  vide(emplacement: string, champ: string, valeur: unknown): void {
    this.valeursVerifiees += 1;
    if (valeur === "" || valeur === null || valeur === undefined) return;
    this.manquements.push({
      emplacement,
      champ,
      genre: "identite-survivante",
      extrait: extrait(typeof valeur === "string" ? valeur : String(valeur)),
    });
  }

  /** Controle negatif : ce champ ne doit plus porter d identite d origine. */
  nettoye(emplacement: string, champ: string, valeur: unknown): void {
    if (typeof valeur !== "string" || valeur === "") return;
    this.valeursVerifiees += 1;
    if (this.origine.ids.has(valeur)) {
      this.survivant(emplacement, champ, valeur);
      return;
    }
    const normalise = normaliser(valeur);
    if (this.origine.usernames.has(normalise) || this.origine.noms.has(normalise)) {
      this.survivant(emplacement, champ, valeur);
      return;
    }
    const mots = normalise.match(MOT) ?? [];
    for (const [rang, mot] of mots.entries()) {
      if (this.origine.motsRecherchables.has(mot)) {
        this.survivant(emplacement, champ, valeur);
        return;
      }
      const suivant = mots[rang + 1];
      if (suivant !== undefined && this.origine.motsRecherchables.has(`${mot} ${suivant}`)) {
        this.survivant(emplacement, champ, valeur);
        return;
      }
    }
  }

  private survivant(emplacement: string, champ: string, valeur: string): void {
    this.manquements.push({
      emplacement,
      champ,
      genre: "identite-survivante",
      extrait: extrait(valeur),
    });
  }
}

/**
 * Positions de reference dans `props`, cles comprises.
 *
 * Les cles comptent : `channel_mentions` porte des slugs de canaux en position
 * de cle et non de valeur. La liste blanche la fait tomber, mais un controle qui
 * ne regarderait que les valeurs ne le verifierait pas.
 */
function controlerProps(post: ArchivePost, emplacement: string, collecteur: Collecteur): void {
  for (const [cle, valeur] of Object.entries(post.props)) {
    collecteur.nettoye(emplacement, `props (cle)`, cle);
    if (PROPS_POSITIONS_REFERENCE.identifiant.has(cle)) {
      collecteur.reference(emplacement, `props.${cle}`, valeur, "uid");
    } else if (PROPS_POSITIONS_REFERENCE.nom.has(cle)) {
      collecteur.reference(emplacement, `props.${cle}`, valeur, "username");
    } else if (PROPS_POSITIONS_REFERENCE.liste.has(cle) && Array.isArray(valeur)) {
      for (const element of valeur) {
        collecteur.reference(emplacement, `props.${cle}[]`, element, "uid");
      }
    } else if (PROPS_POSITIONS_REFERENCE.polymorphe.has(cle)) {
      collecteur.referencePolymorphe(emplacement, `props.${cle}`, valeur);
    }
  }
}

/**
 * Ce que le controle ne peut pas garantir, au niveau applique.
 *
 * Cette liste part dans la synthese et s affiche en fin de run. Elle dit ce que
 * le controle NE VERIFIE PAS ; elle n affirme jamais ce que l archive porte.
 * Une constante figee annoncait « le corps des messages, qui porte encore
 * mentions, noms en clair et adresses » : c etait vrai avant les niveaux, et
 * faux des que le defaut s est mis a remplacer les noms.
 */
function limitesDuControle(niveau: NiveauAnonymisation): string[] {
  const surface: string[] = [];
  if (!reecritLesFormes(niveau)) {
    // Enonce ce qui n est pas reecrit, et non la surface ou cela se trouve : ce
    // niveau touche quand meme au corps des messages, ou il substitue les noms
    // que les metadonnees designent. Dire « le corps des messages, que ce
    // niveau ne reecrit pas » serait faux de la meme facon que la liste figee
    // qu on remplace ici.
    surface.push(
      "les formes ancrees, mentions, adresses, numeros et identifiants, que ce niveau ne reecrit ni dans le corps des messages ni dans les blocs attachments",
    );
  } else if (!reecritLesNoms(niveau)) {
    surface.push(
      "les noms ecrits en clair, dans le corps des messages comme dans les blocs attachments, que ce niveau ne remplace pas",
    );
  } else {
    surface.push(
      "les noms que le vocabulaire n a pas retenus, trop courts, portes par trop de comptes ou trop frequents dans le corpus pour etre remplaces sans detruire le texte",
    );
  }
  return [
    ...surface,
    "le nom et l objet des canaux, conserves pour ne pas casser les permaliens",
    "le nom des emojis personnalises, souvent forme sur un prenom",
    "le nom et la description de la team, qui designent l organisation",
  ];
}

export async function checkResidualIdentities(options: {
  outDir: string;
  origine: IdentitesOrigine;
  substitution: Substitution;
  niveau: NiveauAnonymisation;
}): Promise<ResidualReport> {
  const paths = createArchivePaths(options.outDir);
  const collecteur = new Collecteur(options.origine, options.substitution);

  for await (const user of readNdjson<ArchiveUser>(paths.users)) {
    collecteur.reference("users.ndjson", "id", user.id, "uid");
    collecteur.reference("users.ndjson", "username", user.username, "username");
    collecteur.pseudonyme("users.ndjson", "first_name", user.first_name);
    for (const champ of ["last_name", "nickname", "position"] as const) {
      collecteur.vide("users.ndjson", champ, user[champ]);
    }
    collecteur.vide("users.ndjson", "avatar", user.avatar);
    // `email` est retire, pas vide : le trouver present signale que la passe a
    // laisse traverser un champ qu elle croyait avoir enumere.
    if ("email" in user) {
      collecteur.manquements.push({
        emplacement: "users.ndjson",
        champ: "email",
        genre: "identite-survivante",
        extrait: "champ present",
      });
    }
  }

  let emojisNommes = 0;
  for await (const emoji of readNdjson<ArchiveEmoji>(paths.emojis)) {
    collecteur.reference("emojis.ndjson", "creator_id", emoji.creator_id, "uid");
    for (const jeton of formesCandidates(emoji.name)) {
      const porteurs = options.origine.porteurs.get(jeton) ?? 0;
      if (porteurs >= 1 && porteurs <= 2 && jeton.length >= LONGUEUR_NOM_MINIMALE) {
        emojisNommes += 1;
        break;
      }
    }
  }

  for await (const fichier of readNdjson<ArchiveFile>(paths.files)) {
    collecteur.reference("files.ndjson", "user_id", fichier.user_id, "uid");
    collecteur.nettoye("files.ndjson", "name", fichier.name);
  }

  const candidats: CanalCandidat[] = [];
  for await (const canal of readNdjson<ArchiveChannel>(paths.channels)) {
    collecteur.nettoye("channels.ndjson", "header", canal.header);
    // Les noms de canaux ne sont pas reecrits : ils sont la cle des permaliens.
    // Ceux qui portent une identite sont donc un residu assume, et le seul sur
    // lequel un operateur peut agir a la main avant diffusion.
    for (const [champ, valeur] of [
      ["name", canal.name],
      ["display_name", canal.display_name],
    ] as const) {
      for (const jeton of formesCandidates(valeur)) {
        const porteurs = options.origine.porteurs.get(jeton) ?? 0;
        if (porteurs === 0 || porteurs > 2 || jeton.length < LONGUEUR_NOM_MINIMALE) continue;
        candidats.push({
          nom: canal.name,
          nomAffiche: canal.display_name,
          jeton,
          champ,
          porteurs,
        });
      }
    }
  }

  const mesures = mesuresVides();
  // Agregats par forme, jamais par occurrence ni par message : le rapport dit
  // ce qui reste, sans dire ou le trouver.
  const formes = new Map<string, { occurrences: number; canaux: Set<string> }>();
  const adressesVues = new Set<string>();
  const volumes = new Map<string, number>();

  const postsDir = join(paths.root, ARCHIVE_LAYOUT.postsDir);
  for (const nom of await readdir(postsDir)) {
    if (!nom.endsWith(".ndjson")) continue;
    const canal = nom.slice(0, -".ndjson".length);
    for await (const post of readNdjson<ArchivePost>(join(postsDir, nom))) {
      collecteur.reference(`posts/${nom}`, "user_id", post.user_id, "uid");
      for (const reaction of post.reactions) {
        collecteur.reference(`posts/${nom}`, "reactions[].user_id", reaction.user_id, "uid");
      }
      collecteur.nettoye(`posts/${nom}`, "hashtags", post.hashtags);
      controlerProps(post, `posts/${nom}`, collecteur);

      mesures.messages += 1;
      if (post.user_id !== "") volumes.set(post.user_id, (volumes.get(post.user_id) ?? 0) + 1);
      const systeme = post.type.startsWith("system_");
      if (systeme) mesures.messagesSysteme += 1;

      const texte = post.message;
      if (texte === "") continue;

      const trouvees = mentionsDe(texte);
      // Elles comptent parmi les mentions rencontrees : les exclure du total
      // faisait annoncer moins de mentions que le message n en porte.
      mesures.mentions += trouvees.collectives;
      mesures.mentionsCollectives += trouvees.collectives;
      for (const forme of trouvees.formes) {
        mesures.mentions += 1;
        const minuscule = forme.toLowerCase();
        // Trois cas, et les confondre rendrait le chiffre inutilisable : la
        // mention deja reecrite, celle qui porte encore un nom connu et que la
        // reecriture du texte saura traiter, et celle qui ne designe aucun
        // compte et restera un residu.
        if (options.substitution.usernames.has(minuscule)) {
          mesures.mentionsPseudonymisees += 1;
          continue;
        }
        if (options.origine.usernames.has(normaliser(forme))) {
          mesures.mentionsATraiter += 1;
          continue;
        }
        const vue = formes.get(forme) ?? { occurrences: 0, canaux: new Set<string>() };
        vue.occurrences += 1;
        vue.canaux.add(canal);
        formes.set(forme, vue);
      }

      const adresses = adressesDe(texte);
      if (adresses.length > 0) {
        mesures.messagesAvecAdresse += 1;
        mesures.adresses += adresses.length;
        for (const adresse of adresses) adressesVues.add(adresse.toLowerCase());
      }

      mesures.telephones += telephonesDe(texte);

      // Un identifiant de compte colle dans le corps : detection par
      // appartenance exacte a l ensemble d origine, donc sans faux positif.
      const colles = identifiantsDe(texte).filter((id) => options.origine.ids.has(id));
      if (colles.length > 0) {
        mesures.identifiantsCollesMessages += 1;
        mesures.identifiantsCollesOccurrences += colles.length;
        // Les totaux se comptent toujours, le detail se plafonne : c est la
        // seule structure du controle qui croissait avec les messages.
        if (mesures.identifiantsColles.length < PLAFOND_IDENTIFIANTS_COLLES) {
          mesures.identifiantsColles.push({
            postId: post.id,
            canal,
            occurrences: colles.length,
          });
        }
      }

      // Un message systeme dont le texte porte encore le nom d un compte. La
      // passe substitue ces noms : en trouver un est un echec de la passe, et
      // non un residu comme le corps des messages humains.
      //
      // Le controle ne verifie pas que ce nom soit celui du compte que la ligne
      // designe par ailleurs : il faudrait la table des identites, que ce code
      // n a pas. Il compte une presence, pas un appariement, et le rapport le
      // dit ainsi.
      if (systeme) {
        const jetons = new Set(texte.toLowerCase().match(/[a-z0-9_-][a-z0-9._-]*/g) ?? []);
        for (const jeton of jetons) {
          if (jeton.length >= LONGUEUR_NOM_MINIMALE && options.origine.usernames.has(jeton)) {
            mesures.nomsResiduelsSysteme += 1;
            break;
          }
        }
      }
    }
  }

  mesures.adressesDistinctes = adressesVues.size;
  mesures.formesNonResolues = [...formes.entries()]
    .map(
      ([forme, vue]): FormeResiduelle => ({
        forme,
        occurrences: vue.occurrences,
        canaux: vue.canaux.size,
        connueDeLAnnuaire: options.origine.noms.has(normaliser(forme)),
      }),
    )
    // Tri par forme et non par volume : un tri par volume est la fuite du
    // volume sous forme ordinale.
    .sort((a, b) => (a.forme < b.forme ? -1 : a.forme > b.forme ? 1 : 0));

  const parVolume = [...volumes.values()];
  mesures.canauxCandidats = candidats;
  mesures.canauxDistincts = new Set(candidats.map((c) => c.nom)).size;
  mesures.emojisNommes = emojisNommes;
  mesures.compteLePlusActif = parVolume.length === 0 ? 0 : Math.max(...parVolume);
  mesures.comptesAuDessusDeCent = parVolume.filter((n) => n > 100).length;

  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as Manifest;
  collecteur.reference(
    "manifest.json",
    "extracted_by.user_id",
    manifest.extracted_by.user_id,
    "uid",
  );
  collecteur.reference(
    "manifest.json",
    "extracted_by.username",
    manifest.extracted_by.username,
    "username",
  );
  collecteur.nettoye("manifest.json", "source.url", manifest.source.url);
  for (const warning of manifest.warnings) {
    collecteur.nettoye("manifest.json", "warnings[].detail", warning.detail);
  }

  return {
    referencesVerifiees: collecteur.referencesVerifiees,
    valeursVerifiees: collecteur.valeursVerifiees,
    manquements: collecteur.manquements,
    mesures,
    horsControle: limitesDuControle(options.niveau),
  };
}
