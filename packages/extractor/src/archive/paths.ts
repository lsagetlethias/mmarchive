import { isAbsolute, join, relative as relativeNativePath, resolve, sep } from "node:path";
import { ARCHIVE_LAYOUT, isMattermostId } from "@mmarchive/shared";

/** Borne imposee par les systemes de fichiers courants, comptee en octets UTF-8. */
const MAX_FILE_NAME_BYTES = 200;

/**
 * Au dela de cette taille, ce qui suit le dernier point n est pas une extension
 * mais du texte : la preserver mangerait tout le budget d octets du nom.
 */
const MAX_EXTENSION_BYTES = 32;

const DEFAULT_FALLBACK_NAME = "fichier";

const POSTS_EXTENSION = ".ndjson";
const PART_SUFFIX = ".part";
const IMAGE_EXTENSION = ".png";

const FORBIDDEN_CHARS = new Set(["/", "\\", "<", ">", ":", '"', "|", "?", "*"]);

/**
 * Marques directionnelles et espaces de largeur nulle : invisibles a l affichage,
 * mais conserves tels quels par les systemes de fichiers. Un nom
 * "facture<U+202E>gnp.exe" s affiche "factureexe.png" dans n importe quel
 * explorateur. Les noms de pieces jointes viennent de tiers, c est une entree
 * hostile ; le nom d origine reste intact dans le champ name de files.ndjson.
 */
const INVISIBLE_FORMAT_CHARS = new Set([
  "\u200b",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\ufeff",
]);

const RESERVED_WINDOWS_NAMES = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
]);

export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivePathError";
  }
}

function isUnsafeChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  // C0, DEL et C1 : tous invisibles ou destructeurs a l affichage d un terminal.
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return true;
  }
  return FORBIDDEN_CHARS.has(char) || INVISIBLE_FORMAT_CHARS.has(char);
}

function stripUnsafeChars(value: string): string {
  let result = "";
  for (const char of value) {
    if (!isUnsafeChar(char)) {
      result += char;
    }
  }
  return result;
}

/**
 * Windows supprime silencieusement espaces et points finaux a la creation : les
 * laisser ferait diverger le nom ecrit sur disque du chemin note dans l archive.
 */
function trimTrailingDotsAndSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "." || value[end - 1] === " ")) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isTraversalName(value: string): boolean {
  return value === "." || value === "..";
}

function isReservedWindowsName(value: string): boolean {
  const firstDot = value.indexOf(".");
  const stem = firstDot === -1 ? value : value.slice(0, firstDot);
  return RESERVED_WINDOWS_NAMES.has(stem.trim().toUpperCase());
}

/** Coupe sur une frontiere de point de code, jamais au milieu d un caractere. */
function sliceToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) {
      break;
    }
    result += char;
    used += size;
  }
  return result;
}

function boundToMaxBytes(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_FILE_NAME_BYTES) {
    return value;
  }
  const lastDot = value.lastIndexOf(".");
  if (lastDot > 0) {
    const extension = value.slice(lastDot);
    const extensionBytes = Buffer.byteLength(extension, "utf8");
    if (extensionBytes <= MAX_EXTENSION_BYTES) {
      const base = sliceToBytes(value.slice(0, lastDot), MAX_FILE_NAME_BYTES - extensionBytes);
      if (base !== "") {
        return base + extension;
      }
    }
  }
  return sliceToBytes(value, MAX_FILE_NAME_BYTES);
}

/**
 * L ordre de cette pipeline EST la garantie de surete, et il n existe qu ici : tout
 * nom, y compris un repli fourni par l appelant, passe exactement par les memes
 * etapes. Retrait des caracteres dangereux d abord, ce qui rend la chaine
 * structurellement incapable de sortir de son repertoire. Bornage en octets ensuite,
 * puis re-rognage parce que la troncature peut reexposer un point ou un espace final.
 * Nom reserve verifie en dernier, apres la troncature : c est le seul ordre ou un nom
 * long ne peut pas redevenir un nom de peripherique en etant coupe.
 * Retourne la chaine vide quand il ne reste rien d exploitable.
 */
function sanitizeSegment(value: string): string {
  const stripped = trimTrailingDotsAndSpaces(stripUnsafeChars(value));
  if (stripped === "" || isTraversalName(stripped)) {
    return "";
  }

  const bounded = trimTrailingDotsAndSpaces(boundToMaxBytes(stripped));
  if (bounded === "" || isTraversalName(bounded)) {
    return "";
  }
  if (!isReservedWindowsName(bounded)) {
    return bounded;
  }

  // Le prefixe suffit a neutraliser le nom de peripherique et survit a la
  // re-troncature, qui ne rogne que la fin du nom.
  return trimTrailingDotsAndSpaces(boundToMaxBytes(`_${bounded}`));
}

/**
 * Rend un nom de fichier sur de tout systeme de fichiers. Le nom d origine reste
 * conserve intact dans files.ndjson, ce resultat ne sert qu au disque.
 */
export function sanitizeFileName(name: string, fallback: string = DEFAULT_FALLBACK_NAME): string {
  const sanitized = sanitizeSegment(name);
  if (sanitized !== "") {
    return sanitized;
  }
  // Le repli de l appelant est une entree comme une autre : il ne doit pas pouvoir
  // reinjecter ce que la pipeline vient de neutraliser.
  const sanitizedFallback = sanitizeSegment(fallback);
  return sanitizedFallback === "" ? DEFAULT_FALLBACK_NAME : sanitizedFallback;
}

function assertMattermostId(id: string, label: string): string {
  if (!isMattermostId(id)) {
    const shown = JSON.stringify(id.length > 40 ? `${id.slice(0, 40)}...` : id);
    throw new ArchivePathError(
      `Identifiant ${label} invalide : ${shown}. Un identifiant Mattermost fait 26 caracteres dans [a-z0-9].`,
    );
  }
  return id;
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

export interface ArchivePaths {
  readonly root: string;
  readonly manifest: string;
  readonly users: string;
  readonly teams: string;
  readonly channels: string;
  readonly emojis: string;
  readonly files: string;
  readonly state: string;
  postsFile(channelId: string): string;
  /** Fichier de travail, en ordre d arrivee, avant inversion chronologique. */
  postsPartFile(channelId: string): string;
  attachmentFile(fileId: string, originalName: string): string;
  avatarFile(userId: string): string;
  emojiFile(emojiId: string): string;
  /** Chemin relatif a la racine, separateurs POSIX, tel qu il apparait dans l archive. */
  relative(absolutePath: string): string;
}

export function createArchivePaths(root: string): ArchivePaths {
  // resolve("") vaut le repertoire courant : sans ce garde-fou, une racine vide
  // eparpillerait silencieusement manifest.json et posts/ la ou la CLI a ete lancee.
  if (root.trim() === "") {
    throw new ArchivePathError(
      "La racine de l archive est vide. Indiquez un repertoire de destination explicite.",
    );
  }

  // La racine est resolue une fois pour toutes : relative() a besoin d une base
  // stable, insensible aux changements de repertoire courant du processus.
  const rootPath = resolve(root);
  const postsDir = join(rootPath, ARCHIVE_LAYOUT.postsDir);
  const attachmentsDir = join(rootPath, ARCHIVE_LAYOUT.attachmentsDir);
  const avatarsDir = join(rootPath, ARCHIVE_LAYOUT.avatarsDir);
  const emojiDir = join(rootPath, ARCHIVE_LAYOUT.emojiDir);

  return {
    root: rootPath,
    manifest: join(rootPath, ARCHIVE_LAYOUT.manifest),
    users: join(rootPath, ARCHIVE_LAYOUT.users),
    teams: join(rootPath, ARCHIVE_LAYOUT.teams),
    channels: join(rootPath, ARCHIVE_LAYOUT.channels),
    emojis: join(rootPath, ARCHIVE_LAYOUT.emojis),
    files: join(rootPath, ARCHIVE_LAYOUT.files),
    state: join(rootPath, ARCHIVE_LAYOUT.state),

    postsFile(channelId: string): string {
      return join(postsDir, `${assertMattermostId(channelId, "de canal")}${POSTS_EXTENSION}`);
    },

    // Meme repertoire que le fichier final : le remplacement en fin d extraction
    // doit rester un rename atomique, donc sur le meme systeme de fichiers.
    postsPartFile(channelId: string): string {
      return join(
        postsDir,
        `${assertMattermostId(channelId, "de canal")}${POSTS_EXTENSION}${PART_SUFFIX}`,
      );
    },

    attachmentFile(fileId: string, originalName: string): string {
      return join(
        attachmentsDir,
        assertMattermostId(fileId, "de piece jointe"),
        sanitizeFileName(originalName),
      );
    },

    avatarFile(userId: string): string {
      return join(avatarsDir, `${assertMattermostId(userId, "d utilisateur")}${IMAGE_EXTENSION}`);
    },

    emojiFile(emojiId: string): string {
      return join(emojiDir, `${assertMattermostId(emojiId, "d emoji")}${IMAGE_EXTENSION}`);
    },

    relative(absolutePath: string): string {
      const target = resolve(absolutePath);
      const relativeToRoot = relativeNativePath(rootPath, target);
      if (relativeToRoot === "") {
        throw new ArchivePathError(
          `Le chemin ${absolutePath} designe la racine de l archive, pas un element de l archive.`,
        );
      }
      if (
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${sep}`) ||
        isAbsolute(relativeToRoot)
      ) {
        throw new ArchivePathError(
          `Le chemin ${absolutePath} est en dehors de l archive ${rootPath}.`,
        );
      }
      return toPosixPath(relativeToRoot);
    },
  };
}
