/**
 * Anonymisation d une archive entiere, en vue de sa diffusion.
 *
 * A ne pas confondre avec `mmarchive-redact`, qui honore la demande d une
 * personne et laisse l archive intacte par ailleurs. Ici tout le monde est
 * pseudonymise, les binaires ne sont pas repris, et rien ne permet de revenir en
 * arriere.
 *
 * L archive source n est JAMAIS modifiee : la commande ecrit une archive neuve.
 * Ce choix n est pas un confort. Le sel est tire puis jete, donc une passe
 * interrompue en place laisserait une archive dont les binaires ont disparu,
 * dont les identites sont intactes, et qu aucun controle ne distinguerait d un
 * resultat abouti. Avec une sortie separee, un echec se solde en jetant la
 * sortie. La copie coute peu puisque les 26 Go de pieces jointes ne sont
 * precisement pas repris.
 *
 * Ce que cette passe NE FAIT PAS, et qu il faut dire plutot que laisser croire :
 * elle ne touche pas au corps des messages. Les mentions, les noms ecrits en
 * clair et les adresses y survivent. A l issue de cette passe l archive n est
 * pas diffusable. Voir docs/DECISION-ANONYMISATION.md.
 */
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ARCHIVE_LAYOUT,
  type ArchiveChannel,
  type ArchiveEmoji,
  type ArchiveFile,
  type ArchivePost,
  type ArchiveTeam,
  type ArchiveUser,
  ERROR_CODES,
  type ErrorCode,
  isMattermostId,
  type Manifest,
  manifestSchema,
  type RewrittenForm,
  systemErrorCode,
} from "@mmarchive/shared";
import { NdjsonWriter, readNdjson } from "@mmarchive/shared/ndjson";
import { type ArchivePaths, createArchivePaths } from "../archive/paths.js";
import { Logger } from "../ui/logger.js";
import { TOOL_VERSION } from "../version.js";
import { buildIdentityTable, type Identite } from "./identity-table.js";
import {
  compterFrequences,
  construireVocabulaire,
  formesCandidates,
  type VocabulaireNoms,
} from "./name-vocabulary.js";
import {
  NIVEAU_PAR_DEFAUT,
  type NiveauAnonymisation,
  reecritLesFormes,
  reecritLesNoms,
  SEUIL_FREQUENCE_PAR_DEFAUT,
} from "./niveau.js";
import {
  type CompteursProps,
  compteursPropsVides,
  type ResolveurIdentite,
  reduireProps,
} from "./props-filter.js";
import {
  type CategorieReference,
  type CompteursReferences,
  compteursReferencesVides,
} from "./report-data.js";
import { reecrireNomsDesignes } from "./system-message.js";
import { type CompteursTexte, compteursTexteVides, reecrireFormesAncrees } from "./text-rewrite.js";

export class AnonymizeError extends Error {
  readonly code: ErrorCode = ERROR_CODES.AnonymizeError;
  constructor(message: string) {
    super(message);
    this.name = "AnonymizeError";
  }
}

/**
 * Formes de texte reecrites, selon le niveau.
 *
 * Le manifeste enumere ce qui a ETE FAIT : une liste figee mentirait par
 * omission des que le niveau change, un lecteur en concluant que les noms
 * subsistent alors qu ils ont ete remplaces.
 */
function formesReecrites(niveau: NiveauAnonymisation): RewrittenForm[] {
  const ancrees: RewrittenForm[] = ["mentions", "adresses", "telephones", "identifiants"];
  return reecritLesNoms(niveau) ? [...ancrees, "noms"] : ancrees;
}

/** Fichiers attendus a la racine d une archive. Tout le reste fait echouer. */
const RACINE_ATTENDUE = new Set<string>([
  ARCHIVE_LAYOUT.manifest,
  ARCHIVE_LAYOUT.users,
  ARCHIVE_LAYOUT.teams,
  ARCHIVE_LAYOUT.channels,
  ARCHIVE_LAYOUT.emojis,
  ARCHIVE_LAYOUT.files,
  ARCHIVE_LAYOUT.state,
]);

const REPERTOIRES_ATTENDUS = new Set<string>([
  ARCHIVE_LAYOUT.postsDir,
  ARCHIVE_LAYOUT.attachmentsDir,
  ARCHIVE_LAYOUT.avatarsDir,
  ARCHIVE_LAYOUT.emojiDir,
]);

/**
 * Repertoires que la sortie ne reprend pas.
 *
 * Le nom d un avatar EST l identifiant du compte : les 3 277 fichiers forment a
 * eux seuls la liste des personnes ayant participe, meme si aucune image n etait
 * lisible. Les pieces jointes portent leur nom de televersement, du texte
 * humain. Les emojis personnalises sont, en pratique, tres souvent des visages,
 * ce qui est l argument meme qui a fait ecarter les avatars.
 */
const REPERTOIRES_NON_REPRIS = [
  ARCHIVE_LAYOUT.attachmentsDir,
  ARCHIVE_LAYOUT.avatarsDir,
  ARCHIVE_LAYOUT.emojiDir,
] as const;

export interface AnonymizeResult {
  readonly comptes: number;
  readonly posts: number;
  readonly canaux: number;
  readonly emojis: number;
  readonly fichiers: number;
  readonly reactions: number;
  /** References d identite hors de props, ventilees par categorie de champ. */
  readonly references: CompteursReferences;
  readonly props: CompteursProps;
  /** Noms substitues dans le texte parce que props les designait nommement. */
  readonly nomsSubstitues: number;
  /** Formes ancrees reecrites dans le corps des messages. */
  readonly texteCorps: CompteursTexte;
  /** Formes ancrees reecrites dans le texte des blocs attachments. */
  readonly texteBlocs: CompteursTexte;
  /** Niveau applique. Le rapport et le manifeste le nomment tous les deux. */
  readonly niveau: NiveauAnonymisation;
  /** Absent aux niveaux qui ne remplacent pas les noms ecrits en clair. */
  readonly vocabulaire: VocabulaireNoms | undefined;
  /** Noms designes par props mais absents du texte. Sans consequence. */
  readonly nomsNonTrouves: number;
  /** Pieces jointes dont la metadonnee est conservee mais le binaire non repris. */
  readonly binairesNonRepris: number;
}

async function estRepertoire(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refuse une arborescence inattendue plutot que de la contourner.
 *
 * Un `.part` ou un `.redact` signale une extraction ou un effacement interrompu,
 * donc une archive peut-etre incomplete. Les ignorer produirait une archive
 * anonyme mais tronquee, sans que rien ne le dise. Le balayage est une liste
 * blanche : les trois parcours existants du depot filtrent sur `.ndjson` et
 * rateraient donc exactement ces fichiers.
 */
async function refuserArborescenceInattendue(racine: string): Promise<void> {
  const inattendus: string[] = [];

  for (const entree of await readdir(racine, { withFileTypes: true })) {
    if (entree.isDirectory()) {
      if (!REPERTOIRES_ATTENDUS.has(entree.name)) inattendus.push(`${entree.name}/`);
      continue;
    }
    if (!RACINE_ATTENDUE.has(entree.name)) inattendus.push(entree.name);
  }

  const postsDir = join(racine, ARCHIVE_LAYOUT.postsDir);
  if (await estRepertoire(postsDir)) {
    for (const entree of await readdir(postsDir, { withFileTypes: true })) {
      const attendu =
        entree.isFile() &&
        entree.name.endsWith(".ndjson") &&
        isMattermostId(entree.name.slice(0, -".ndjson".length));
      if (!attendu) inattendus.push(`${ARCHIVE_LAYOUT.postsDir}/${entree.name}`);
    }
  }

  if (inattendus.length > 0) {
    const listes = inattendus.slice(0, 10).join(", ");
    const reste = inattendus.length > 10 ? ` et ${String(inattendus.length - 10)} autre(s)` : "";
    throw new AnonymizeError(
      `L archive contient des elements que le format ne prevoit pas : ${listes}${reste}. ` +
        "Un fichier de travail signale une operation interrompue, donc une archive peut-etre " +
        "incomplete : anonymiser sans le dire produirait une archive tronquee sans trace. " +
        "Verifiez l archive, puis retirez ces elements.",
    );
  }
}

/**
 * Refuse de tourner sur une archive deja anonymisee.
 *
 * Presque sans effet avant la reecriture du texte, destructeur depuis. Aucune
 * forme de substitution de la premiere passe ne resout contre la NOUVELLE table,
 * donc toutes les mentions deviendraient orphelines et se feraient neutraliser.
 * Le controle residuel ne le verrait pas : il est positif contre le nouvel
 * ensemble de substitution, qui est coherent avec lui-meme. Et l operateur qui a
 * jete la source d origine n a plus de recours.
 */
async function refuserSourceDejaAnonymisee(source: ArchivePaths): Promise<void> {
  if (!(await porteUneArchiveAnonymisee(source.root))) return;
  throw new AnonymizeError(
    `${source.root} porte deja une archive anonymisee. La rejouer tirerait une table neuve, ` +
      "contre laquelle aucun pseudonyme de la premiere passe ne resout : les mentions deviendraient " +
      "toutes orphelines et seraient neutralisees, sans que rien ne le signale. Repartez de " +
      "l archive d origine.",
  );
}

async function refuserSortieOccupee(sortie: string, source: string, force: boolean): Promise<void> {
  const cheminSortie = resolve(sortie);
  const cheminSource = resolve(source);
  if (cheminSortie === cheminSource) {
    throw new AnonymizeError(
      "La sortie designe l archive source. L anonymisation ecrit une archive neuve et ne " +
        "modifie jamais celle qu elle lit.",
    );
  }
  // Une sortie posee sous la source ferait relire par le balayage ce que la
  // passe vient d ecrire, et la source cesserait d etre intacte.
  const versLaSortie = relative(cheminSource, cheminSortie);
  const dehors =
    versLaSortie === ".." || versLaSortie.startsWith(`..${sep}`) || isAbsolute(versLaSortie);
  if (!dehors) {
    throw new AnonymizeError(
      `La sortie ${cheminSortie} est a l interieur de l archive source. Choisissez un ` +
        "repertoire en dehors.",
    );
  }

  let contenu: string[];
  try {
    contenu = await readdir(cheminSortie);
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") return;
    throw cause;
  }
  if (contenu.length === 0) return;

  if (!force) {
    throw new AnonymizeError(
      `${cheminSortie} n est pas vide. Une anonymisation ne se rejoue pas par dessus une ` +
        "precedente : les identifiants de substitution seraient tires a neuf et ne " +
        "correspondraient plus. Videz le repertoire, ou passez --force.",
    );
  }

  // --force ne peut pas se contenter de passer outre : les fichiers de messages
  // portent le nom de leur canal d origine, donc une seconde passe depuis une
  // autre archive laisserait ceux de la premiere en place. Ils feraient partie
  // de l archive produite sans figurer aux compteurs du manifeste, et le
  // controle residuel ne parcourt pas les repertoires binaires qu une copie
  // anterieure aurait pu y deposer.
  if (!(await porteUneArchiveAnonymisee(cheminSortie))) {
    throw new AnonymizeError(
      `${cheminSortie} n est pas vide et ne porte pas d archive anonymisee complete. --force ` +
        "ne remplace qu une sortie produite par cette commande, jamais un repertoire " +
        "quelconque ni une sortie laissee par une passe interrompue. Videz-le vous meme, " +
        "apres avoir verifie ce qu il contient.",
    );
  }
  await rm(cheminSortie, { recursive: true, force: true });
}

/**
 * Vrai si ce repertoire porte le manifeste d une archive deja anonymisee.
 *
 * Sert de garde-fou a --force : c est la seule marque qui distingue une sortie
 * de cette commande d un repertoire de travail quelconque, et elle n est ecrite
 * qu en toute fin de passe, donc une sortie interrompue ne la porte pas.
 */
async function porteUneArchiveAnonymisee(racine: string): Promise<boolean> {
  try {
    const brut: unknown = JSON.parse(await readFile(join(racine, ARCHIVE_LAYOUT.manifest), "utf8"));
    // Deliberement tolerant : la seule presence du bloc suffit, sans valider le
    // reste du manifeste. Un garde-fou qui exigerait un manifeste conforme
    // cesserait de reconnaitre une archive produite par une version dont le bloc
    // a une autre forme, et laisserait la commande tourner sur sa propre sortie,
    // ce qui est precisement le cas destructeur.
    return (
      typeof brut === "object" &&
      brut !== null &&
      "anonymized" in brut &&
      typeof (brut as { anonymized: unknown }).anonymized === "object" &&
      (brut as { anonymized: unknown }).anonymized !== null
    );
  } catch {
    return false;
  }
}

/**
 * Refuse d ecrire un fichier a l interieur de l archive source ou de la sortie.
 *
 * Un rapport pose dans la sortie voyagerait avec chaque copie diffusee, alors
 * qu il designe precisement ce qu on a cherche a cacher ; et `--force` le
 * ferait disparaitre en silence a la passe suivante. Le controle vient avant la
 * passe, pour echouer en une seconde plutot qu apres une demi-minute de travail.
 */
export async function refuserCheminInterne(
  chemin: string,
  source: string,
  sortie: string,
): Promise<void> {
  // `resolve` ne fait que du calcul de chaine : un lien symbolique pose en
  // dehors et pointant vers la sortie passerait le controle, et l ecriture
  // suivrait le lien. On resout donc le parent existant le plus proche, le
  // fichier lui-meme n existant pas encore.
  // Deux formes de la cible, et il faut les deux. La forme lexicale attrape le
  // cas ordinaire ; celle qui suit les liens attrape le contournement, un lien
  // pose en dehors et pointant vers la sortie passant sinon le controle avant
  // que l ecriture ne le suive.
  const cibles = [resolve(chemin), join(await realParent(chemin), basename(chemin))];
  for (const [racine, quoi] of [
    [await realOuResolu(source), "l archive source"],
    [await realOuResolu(sortie), "l archive produite"],
  ] as const) {
    const dehors = cibles.every((cible) => {
      const versLaCible = relative(racine, cible);
      return versLaCible === ".." || versLaCible.startsWith(`..${sep}`) || isAbsolute(versLaCible);
    });
    if (!dehors) {
      throw new AnonymizeError(
        `${resolve(chemin)} est a l interieur de ${quoi}. Le rapport designe ce que l anonymisation a ` +
          "cherche a cacher : il ne doit ni voyager avec l archive, ni etre efface avec elle.",
      );
    }
  }
}

/** Chemin reel s il existe, sinon le chemin resolu lexicalement. */
async function realOuResolu(chemin: string): Promise<string> {
  try {
    return await realpath(chemin);
  } catch (cause) {
    if (systemErrorCode(cause) !== "ENOENT") throw cause;
    return resolve(chemin);
  }
}

/**
 * Chemin reel du repertoire qui contiendra ce fichier, liens suivis.
 *
 * Le fichier n existe pas encore, donc il n a pas de `realpath` : on remonte
 * jusqu au premier ancetre existant, ce qui suit un lien pose sur le chemin.
 *
 * La remontee ne vaut que pour la CIBLE. L appliquer aux racines les
 * elargirait : une sortie qui n existe pas encore verrait sa racine remonter au
 * repertoire parent, et tout voisin y serait declare interieur.
 */
async function realParent(chemin: string): Promise<string> {
  let candidat = dirname(resolve(chemin));
  for (;;) {
    try {
      return await realpath(candidat);
    } catch (cause) {
      if (systemErrorCode(cause) !== "ENOENT") throw cause;
      const parent = dirname(candidat);
      // La racine est son propre parent : sans cette sortie, la boucle tourne.
      if (parent === candidat) return candidat;
      candidat = parent;
    }
  }
}

/** Copie a l identique une liste de champs, en n en laissant passer aucun autre. */
function anonymiserUser(user: ArchiveUser, identite: Identite): ArchiveUser {
  // Enumerer ce qu on garde plutot que retirer ce qui gene : un champ ajoute au
  // format un jour ne doit pas traverser cette passe sans que personne ne l ait
  // regarde. `email` disparait ainsi sans traitement particulier.
  return {
    id: identite.uid,
    username: identite.username,
    nickname: "",
    first_name: identite.pseudonyme,
    last_name: "",
    position: "",
    roles: user.roles,
    is_bot: user.is_bot,
    create_at: user.create_at,
    delete_at: user.delete_at,
    avatar: null,
  };
}

function libelleNeutre(fichier: ArchiveFile, rang: number): string {
  const extension = fichier.extension.replace(/^\.+/, "");
  const suffixe = extension === "" ? "" : `.${extension}`;
  return `piece-jointe-${String(rang)}${suffixe}`;
}

export async function anonymizeArchive(options: {
  archiveDir: string;
  outDir: string;
  force?: boolean;
  niveau?: NiveauAnonymisation;
  /** Au dela, une forme est traitee comme un mot ordinaire et non comme un nom. */
  seuilFrequence?: number;
  logger?: Logger;
}): Promise<AnonymizeResult> {
  const logger = options.logger ?? new Logger();
  const force = options.force ?? false;
  const niveau = options.niveau ?? NIVEAU_PAR_DEFAUT;
  const seuilFrequence = options.seuilFrequence ?? SEUIL_FREQUENCE_PAR_DEFAUT;
  const source = createArchivePaths(options.archiveDir);
  const sortie = createArchivePaths(options.outDir);

  try {
    await stat(source.manifest);
  } catch {
    throw new AnonymizeError(
      `${options.archiveDir} ne ressemble pas a une archive mmarchive : manifest.json est introuvable.`,
    );
  }

  await refuserSourceDejaAnonymisee(source);
  await refuserArborescenceInattendue(source.root);
  await refuserSortieOccupee(sortie.root, source.root, force);
  await mkdir(join(sortie.root, ARCHIVE_LAYOUT.postsDir), { recursive: true });

  logger.info("Construction de la table d identites de substitution.");
  const identifiants: string[] = [];
  for await (const user of readNdjson<ArchiveUser>(source.users)) identifiants.push(user.id);
  const table = buildIdentityTable(identifiants);

  const parUsername = new Map<string, Identite>();
  for await (const user of readNdjson<ArchiveUser>(source.users)) {
    const identite = table.get(user.id);
    if (identite !== undefined && user.username !== "") {
      parUsername.set(user.username.toLowerCase(), identite);
    }
  }
  // Les noms de substitution emis, pour que la reecriture du texte reconnaisse
  // ce qu une passe anterieure a deja traite au lieu de le prendre pour une
  // mention orpheline et de le neutraliser.
  const emis = new Set([...table.values()].map((identite) => identite.username));
  const resolveur: ResolveurIdentite = {
    parId: (id) => table.get(id),
    parUsername: (nom) => parUsername.get(nom.toLowerCase()),
    estSubstitution: (nom) => emis.has(nom.toLowerCase()),
    uidPourIdentifiant: (id) => table.get(id)?.uid,
  };

  /**
   * Vocabulaire des noms ecrits en clair, au seul niveau qui les remplace.
   *
   * Il demande une passe de lecture supplementaire pour compter les frequences,
   * et c est le prix de la seule etape sans ancrage : sans ce comptage, rien ne
   * distingue un prenom d un mot ordinaire qui se trouve etre aussi un nom.
   */
  let vocabulaire: VocabulaireNoms | undefined;
  if (reecritLesNoms(niveau)) {
    logger.info("Comptage des noms dans le corpus.");
    const candidates = new Set<string>();
    const parIdentite = new Map<string, string>();
    for await (const user of readNdjson<ArchiveUser>(source.users)) {
      for (const forme of formesCandidates(user)) candidates.add(forme);
      const identite = table.get(user.id);
      if (identite !== undefined) parIdentite.set(user.id, identite.pseudonyme);
    }
    const frequences = await compterFrequences(source.root, candidates);
    const users: ArchiveUser[] = [];
    for await (const user of readNdjson<ArchiveUser>(source.users)) users.push(user);
    vocabulaire = construireVocabulaire(users, parIdentite, frequences, seuilFrequence);
    logger.info(
      `${String(vocabulaire.formes.size)} formes retenues, ` +
        `${String(vocabulaire.ecarteesParFrequence)} ecartees comme trop frequentes, ` +
        `${String(vocabulaire.comptesCouverts)} comptes couverts et ` +
        `${String(vocabulaire.comptesNonCouverts)} laisses nommables.`,
    );
  }

  const props = compteursPropsVides();
  const references = compteursReferencesVides();
  let nomsSubstitues = 0;
  let nomsNonTrouves = 0;
  // Deux surfaces, deux compteurs : le taux de resolution des mentions y est de
  // 94 % d un cote et de 2 % de l autre, les sommer decrirait une population qui
  // n existe pas.
  const texteCorps = compteursTexteVides();
  const texteBlocs = compteursTexteVides();

  /**
   * Une reference qui ne resout vers aucun compte est retiree, jamais conservee.
   *
   * Le cas est reel : sur l archive de reference, 156 identifiants portes par
   * des messages systeme et par des emojis ne correspondent a aucune fiche,
   * parce que le compte a ete supprime de l instance ou que sa recuperation a
   * echoue pendant l extraction. Un repli du type `table.get(x) ?? x` les
   * laisserait intacts, et le controle residuel ne pourrait pas les voir
   * puisqu il ne connait que les comptes presents.
   */
  const substituer = (id: string, categorie: CategorieReference): string | null => {
    const identite = table.get(id);
    if (identite === undefined) {
      // Compte par categorie, et pas seulement dans props : une reaction dont le
      // compte ne resout pas disparaissait de l archive sans qu aucun compteur
      // ne le dise, donc sans que le rapport puisse le rapporter.
      references[categorie].orphelines += 1;
      return null;
    }
    references[categorie].reecrites += 1;
    return identite.uid;
  };

  /**
   * Les comptes sortent dans l ordre de leur identifiant de substitution, pas
   * dans celui de la source.
   *
   * Ecrire ligne pour ligne dans l ordre lu rendait la correspondance complete a
   * qui detient l archive d origine : un `paste` entre les deux fichiers suffit,
   * puisque la n-ieme fiche anonyme est la n-ieme fiche reelle. La promesse est
   * que la correspondance n existe nulle part, pas qu elle soit penible a
   * reconstituer.
   *
   * Le tri tient en memoire, borne par le nombre de comptes et non par celui des
   * messages : 3 277 fiches sur l archive de reference.
   */
  const anonymes: ArchiveUser[] = [];
  for await (const user of readNdjson<ArchiveUser>(source.users)) {
    const identite = table.get(user.id);
    if (identite === undefined) continue;
    anonymes.push(anonymiserUser(user, identite));
  }
  anonymes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let comptes = 0;
  const users = await NdjsonWriter.open(sortie.users);
  try {
    for (const anonyme of anonymes) {
      await users.write(anonyme);
      comptes += 1;
    }
  } finally {
    await users.close();
  }

  let emojis = 0;
  const fluxEmojis = await NdjsonWriter.open(sortie.emojis);
  try {
    for await (const emoji of readNdjson<ArchiveEmoji>(source.emojis)) {
      // Les lignes se conservent toutes : `counts.emojis` est confronte au
      // fichier par la verification, et en retirer ferait echouer l archive sur
      // son propre manifeste.
      const anonyme: ArchiveEmoji = {
        id: emoji.id,
        name: emoji.name,
        creator_id: substituer(emoji.creator_id, "emojis") ?? "",
        create_at: emoji.create_at,
        update_at: emoji.update_at,
        delete_at: emoji.delete_at,
        image: null,
      };
      await fluxEmojis.write(anonyme);
      emojis += 1;
    }
  } finally {
    await fluxEmojis.close();
  }

  let fichiers = 0;
  let binairesNonRepris = 0;
  const fluxFichiers = await NdjsonWriter.open(sortie.files);
  try {
    for await (const fichier of readNdjson<ArchiveFile>(source.files)) {
      fichiers += 1;
      if (fichier.path !== null) binairesNonRepris += 1;
      // `path` passe a null parce que le binaire n est pas repris : le laisser
      // renseigne ferait echouer la verification sur autant de fichiers absents.
      // `name` est remplace plutot que vide, parce que le viewer l affiche meme
      // quand le binaire manque, et qu un nom de televersement porte souvent une
      // identite.
      const anonyme: ArchiveFile = {
        id: fichier.id,
        post_id: fichier.post_id,
        channel_id: fichier.channel_id,
        user_id: substituer(fichier.user_id, "fichiers") ?? "",
        name: libelleNeutre(fichier, fichiers),
        extension: fichier.extension,
        size: fichier.size,
        mime_type: fichier.mime_type,
        width: fichier.width,
        height: fichier.height,
        has_preview_image: fichier.has_preview_image,
        create_at: fichier.create_at,
        delete_at: fichier.delete_at,
        path: null,
      };
      await fluxFichiers.write(anonyme);
    }
  } finally {
    await fluxFichiers.close();
  }

  let canaux = 0;
  const fluxCanaux = await NdjsonWriter.open(sortie.channels);
  try {
    for await (const canal of readNdjson<ArchiveChannel>(source.channels)) {
      // `header` porte couramment un contact nominatif ou un lien de reunion. Il
      // entre dans l index sans qu aucune vue ne l affiche : il voyagerait donc
      // dans toute copie diffusee sans qu une relecture puisse le voir.
      await fluxCanaux.write({ ...canal, header: "" });
      canaux += 1;
    }
  } finally {
    await fluxCanaux.close();
  }

  let teams = 0;
  const fluxTeams = await NdjsonWriter.open(sortie.teams);
  try {
    for await (const team of readNdjson<ArchiveTeam>(source.teams)) {
      await fluxTeams.write(team);
      teams += 1;
    }
  } finally {
    await fluxTeams.close();
  }

  let posts = 0;
  let reactions = 0;
  let premier: number | null = null;
  let dernier: number | null = null;
  const nomsPosts = (await readdir(join(source.root, ARCHIVE_LAYOUT.postsDir))).filter((nom) =>
    nom.endsWith(".ndjson"),
  );
  for (const nom of nomsPosts) {
    const entree = join(source.root, ARCHIVE_LAYOUT.postsDir, nom);
    const flux = await NdjsonWriter.open(join(sortie.root, ARCHIVE_LAYOUT.postsDir, nom));
    try {
      for await (const post of readNdjson<ArchivePost>(entree)) {
        const auteur = substituer(post.user_id, "auteurs");
        const reactionsAnonymes = post.reactions.flatMap((reaction) => {
          const uid = substituer(reaction.user_id, "reactions");
          if (uid === null) return [];
          reactions += 1;
          return [{ ...reaction, user_id: uid }];
        });
        // Avant de reduire props : c est lui qui porte encore les noms tels
        // qu ils apparaissent dans le texte, et sans cette passe la ligne
        // apparie l identite reelle et son substitut.
        const texte = reecrireNomsDesignes(post, resolveur);
        nomsSubstitues += texte.substitutions;
        nomsNonTrouves += texte.nonTrouves;
        // Puis les formes ancrees, sur le resultat : les noms que props designe
        // sont deja substitues, donc les mentions qui les portent resolvent vers
        // un nom de substitution et sont reconnues comme deja traitees.
        //
        // La substitution ci-dessus, elle, ne depend d aucun niveau : sans elle,
        // une ligne apparie une identite reelle et son pseudonyme, ce qui n a de
        // sens a aucun niveau.
        const corps = reecritLesFormes(niveau)
          ? reecrireFormesAncrees(texte.message, resolveur, texteCorps, vocabulaire?.formes)
          : texte.message;
        const anonyme: ArchivePost = {
          id: post.id,
          channel_id: post.channel_id,
          user_id: auteur ?? "",
          create_at: post.create_at,
          update_at: post.update_at,
          edit_at: post.edit_at,
          delete_at: post.delete_at,
          root_id: post.root_id,
          type: post.type,
          message: corps,
          is_pinned: post.is_pinned,
          // Les mots-diese sont une derivation du corps du message : `#prenom.nom`
          // y survivrait a une reecriture du corps, et l index en fait une colonne
          // cherchable a part.
          hashtags: "",
          props: reduireProps(
            post.props,
            resolveur,
            props,
            reecritLesFormes(niveau) ? texteBlocs : undefined,
            vocabulaire?.formes,
          ),
          file_ids: post.file_ids,
          reactions: reactionsAnonymes,
        };
        await flux.write(anonyme);
        posts += 1;
        if (post.create_at > 0 && (premier === null || post.create_at < premier)) {
          premier = post.create_at;
        }
        if (dernier === null || post.create_at > dernier) dernier = post.create_at;
      }
    } finally {
      await flux.close();
    }
  }

  await ecrireManifeste(source.manifest, sortie.manifest, {
    niveau,
    table,
    parUsername,
    counts: { teams, channels: canaux, posts, users: comptes, emojis, attachments: 0 },
    premier,
    dernier,
  });

  logger.info(
    `Archive anonymisee dans ${sortie.root} : ${String(comptes)} comptes, ${String(posts)} messages, ` +
      `${String(binairesNonRepris)} pieces jointes non reprises.`,
  );
  for (const repertoire of REPERTOIRES_NON_REPRIS) {
    logger.info(`  ${repertoire}/ n est pas repris.`);
  }

  return {
    comptes,
    posts,
    canaux,
    emojis,
    fichiers,
    reactions,
    references,
    props,
    nomsSubstitues,
    nomsNonTrouves,
    texteCorps,
    texteBlocs,
    niveau,
    vocabulaire,
    binairesNonRepris,
  };
}

async function ecrireManifeste(
  entree: string,
  destination: string,
  contexte: {
    niveau: NiveauAnonymisation;
    table: Map<string, Identite>;
    parUsername: Map<string, Identite>;
    counts: {
      teams: number;
      channels: number;
      posts: number;
      users: number;
      emojis: number;
      attachments: number;
    };
    premier: number | null;
    dernier: number | null;
  },
): Promise<void> {
  const brut: unknown = JSON.parse(await readFile(entree, "utf8"));
  const lu = manifestSchema.safeParse(brut);
  if (!lu.success) {
    throw new AnonymizeError(
      `${basename(entree)} n est pas un manifeste valide : ${lu.error.issues[0]?.message ?? "forme inattendue"}.`,
    );
  }
  const manifest = lu.data;

  const operateur =
    contexte.table.get(manifest.extracted_by.user_id) ??
    contexte.parUsername.get(manifest.extracted_by.username.toLowerCase());

  const anonyme: Manifest = {
    ...manifest,
    source: {
      // L URL nomme l organisation source et rend operante toute la
      // reidentification par recoupement. `server_version` reste : c est une
      // version de Mattermost, elle ne designe personne.
      url: "",
      server_version: manifest.source.server_version,
    },
    extracted_by: {
      user_id: operateur?.uid ?? "",
      username: operateur?.username ?? "",
      was_system_admin: manifest.extracted_by.was_system_admin,
    },
    counts: {
      ...manifest.counts,
      ...contexte.counts,
      attachments_bytes: 0,
    },
    // Le detail d un avertissement est de la prose d erreur interpolee avec des
    // noms de comptes et des noms de fichiers. On ne reecrit pas sainement de la
    // prose : le code et le decompte suffisent a auditer ce qui manque.
    warnings: manifest.warnings.map((warning) => ({ ...warning, detail: "" })),
    anonymized: {
      at: new Date().toISOString(),
      tool_version: TOOL_VERSION,
      /**
       * Dit une fois, ici, ce qui serait autrement repete sur chaque ligne de
       * `files.ndjson` par une valeur de `skip_reason` qu il faudrait ajouter a
       * un enum ferme, au prix d une evolution du format.
       */
      binaries_removed: true,
      // Les deux surfaces portent les memes formes : le meme moteur et la meme
      // table tournent sur les deux, et la promesse doit etre unique.
      niveau: contexte.niveau,
      text_rewritten: reecritLesFormes(contexte.niveau)
        ? {
            message: formesReecrites(contexte.niveau),
            "props.attachments": formesReecrites(contexte.niveau),
          }
        : {},
    },
    ...(contexte.premier === null || contexte.dernier === null
      ? {}
      : { post_range: { first_create_at: contexte.premier, last_create_at: contexte.dernier } }),
  };

  await writeFile(destination, `${JSON.stringify(anonyme, null, 2)}\n`, "utf8");
}
