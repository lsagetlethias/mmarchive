import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ArchiveEmoji,
  ArchiveFile,
  ArchiveUser,
  ArchiveWarning,
  FileSkipReason,
} from "@mmarchive/shared";
import { NdjsonWriter, readNdjson } from "@mmarchive/shared/ndjson";
import type { ArchivePaths } from "../archive/paths.js";
import type { MattermostApi } from "../mattermost/api.js";
import { isBotUser, type MmEmoji, type MmFileInfo, type MmUser } from "../mattermost/types.js";
import { mapWithConcurrency } from "./concurrency.js";

export interface AssetOptions {
  readonly api: MattermostApi;
  readonly paths: ArchivePaths;
  readonly includeEmails: boolean;
  readonly skipFiles: boolean;
  readonly maxFileSizeBytes: number;
  /** Telechargements de pieces jointes menes de front. Defaut : 1 (sequentiel). */
  readonly downloadConcurrency?: number | undefined;
  readonly onProgress?: ((done: number, total: number, label: string) => void) | undefined;
}

async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export interface UsersResult {
  readonly count: number;
  readonly warnings: readonly ArchiveWarning[];
}

/**
 * Resout les utilisateurs rencontres et telecharge leurs avatars.
 *
 * Les comptes desactives (delete_at != 0) sont conserves : leurs messages
 * restent references dans l archive, les effacer rendrait l historique
 * illisible.
 */
export async function extractUsers(
  options: AssetOptions & { userIds: ReadonlySet<string>; alreadyDone?: ReadonlySet<string> },
): Promise<UsersResult> {
  const warnings: ArchiveWarning[] = [];

  /**
   * Le fichier fait foi, pas l etat.
   *
   * users.ndjson etait ouvert en ajout et la liste des utilisateurs deja resolus
   * venait de l etat, qui n etait pas toujours persiste : chaque run reecrivait
   * alors tout le monde. Constate sur une archive reelle, 7 727 lignes pour
   * 3 277 utilisateurs distincts, certains presents trois fois. On relit donc
   * l existant, et le fichier est reecrit complet et dedoublonne.
   */
  const existing = new Map<string, ArchiveUser>();
  try {
    for await (const user of readNdjson<ArchiveUser>(options.paths.users)) {
      existing.set(user.id, user);
    }
  } catch {
    // Fichier absent au premier run.
  }

  const pending = [...options.userIds].filter((id) => !existing.has(id));
  if (pending.length === 0) {
    // Rien a resoudre, mais le fichier peut contenir des doublons herites.
    if (existing.size > 0) await rewriteUsers(options.paths.users, [...existing.values()]);
    return { count: existing.size, warnings };
  }

  let users: MmUser[];
  try {
    users = await options.api.getUsersByIds(pending);
  } catch (error) {
    warnings.push({
      code: "USER_FETCH_FAILED",
      detail: `Resolution de ${String(pending.length)} utilisateur(s) impossible : ${
        error instanceof Error ? error.message : "erreur inconnue"
      }`,
    });
    return { count: 0, warnings };
  }

  let done = 0;
  const avatars = await mapWithConcurrency(
    users,
    options.downloadConcurrency ?? 1,
    async (user) => {
      try {
        const image = await options.api.downloadAvatar(user.id);
        const path = options.paths.avatarFile(user.id);
        await writeBinary(path, image.bytes);
        return options.paths.relative(path);
      } catch (error) {
        warnings.push({
          code: "AVATAR_DOWNLOAD_FAILED",
          detail: `Avatar de ${user.username} indisponible : ${
            error instanceof Error ? error.message : "erreur inconnue"
          }`,
        });
        return null;
      } finally {
        done += 1;
        options.onProgress?.(done, users.length, user.username);
      }
    },
  );

  for (const [index, user] of users.entries()) {
    const avatar = avatars[index] ?? null;
    {
      const record: ArchiveUser = {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        first_name: user.first_name,
        last_name: user.last_name,
        position: user.position,
        roles: user.roles,
        is_bot: isBotUser(user),
        create_at: user.create_at,
        delete_at: user.delete_at,
        avatar,
        // Aucun champ de contact n entre dans l archive sans demande explicite.
        ...(options.includeEmails && user.email !== undefined ? { email: user.email } : {}),
      };
      existing.set(record.id, record);
    }
  }

  await rewriteUsers(options.paths.users, [...existing.values()]);
  return { count: existing.size, warnings };
}

/** Reecrit l annuaire complet de facon atomique, sans doublon. */
async function rewriteUsers(path: string, records: readonly ArchiveUser[]): Promise<void> {
  const temporary = `${path}.rewrite`;
  const writer = await NdjsonWriter.open(temporary);
  try {
    await writer.writeMany(records);
  } finally {
    await writer.close();
  }
  await rename(temporary, path);
}

export interface EmojisResult {
  readonly count: number;
  /**
   * false quand le listing lui-meme a echoue. Une liste vide est un resultat
   * legitime, un echec ne l est pas : les confondre ferait poser le drapeau
   * emojis_done et perdrait definitivement la table des emojis, que rien ne
   * permettrait plus de redemander.
   */
  readonly listed: boolean;
  readonly warnings: readonly ArchiveWarning[];
}

/**
 * Emojis personnalises de l instance. Necessaires au rendu des reactions : une
 * reaction ne reference qu un emoji_name, jamais une image.
 */
export async function extractEmojis(options: AssetOptions): Promise<EmojisResult> {
  const warnings: ArchiveWarning[] = [];
  let emojis: MmEmoji[];
  try {
    emojis = await options.api.getCustomEmojis();
  } catch (error) {
    warnings.push({
      code: "EMOJI_DOWNLOAD_FAILED",
      detail: `Liste des emojis personnalises indisponible : ${
        error instanceof Error ? error.message : "erreur inconnue"
      }`,
    });
    return { count: 0, listed: false, warnings };
  }

  let done = 0;
  const images = await mapWithConcurrency(
    emojis,
    options.downloadConcurrency ?? 1,
    async (emoji) => {
      try {
        const binary = await options.api.downloadEmojiImage(emoji.id);
        const path = options.paths.emojiFile(emoji.id);
        await writeBinary(path, binary.bytes);
        return options.paths.relative(path);
      } catch (error) {
        warnings.push({
          code: "EMOJI_DOWNLOAD_FAILED",
          detail: `Image de l emoji ${emoji.name} indisponible : ${
            error instanceof Error ? error.message : "erreur inconnue"
          }`,
        });
        return null;
      } finally {
        done += 1;
        options.onProgress?.(done, emojis.length, emoji.name);
      }
    },
  );

  const writer = await NdjsonWriter.open(options.paths.emojis);
  try {
    for (const [index, emoji] of emojis.entries()) {
      const image = images[index] ?? null;

      const record: ArchiveEmoji = {
        id: emoji.id,
        name: emoji.name,
        creator_id: emoji.creator_id,
        create_at: emoji.create_at,
        update_at: emoji.update_at,
        delete_at: emoji.delete_at,
        image,
      };
      await writer.write(record);
    }
  } finally {
    await writer.close();
  }

  return { count: emojis.length, listed: true, warnings };
}

export interface FilesResult {
  readonly downloaded: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly warnings: readonly ArchiveWarning[];
}

/**
 * Pieces jointes. La metadonnee est TOUJOURS ecrite, meme quand le binaire est
 * absent : le viewer doit pouvoir afficher "piece jointe non archivee" plutot
 * que de faire disparaitre silencieusement une information qui existait.
 */
export async function extractFiles(
  options: AssetOptions & {
    files: readonly MmFileInfo[];
    channelId: string;
    alreadyDone: ReadonlySet<string>;
  },
): Promise<FilesResult> {
  const warnings: ArchiveWarning[] = [];
  let downloaded = 0;
  let bytes = 0;
  let skipped = 0;

  const unique = new Map<string, MmFileInfo>();
  for (const file of options.files) {
    if (!options.alreadyDone.has(file.id)) unique.set(file.id, file);
  }
  if (unique.size === 0) return { downloaded, bytes, skipped, warnings };

  /** Telecharge un fichier sans rien ecrire : la sortie reste sequentielle. */
  async function fetchOne(
    file: MmFileInfo,
  ): Promise<{ path: string | null; skipReason: FileSkipReason | undefined; size: number }> {
    if (options.skipFiles) {
      return { path: null, skipReason: "skipped_by_option", size: 0 };
    }
    if (file.size > options.maxFileSizeBytes) {
      warnings.push({
        code: "FILE_TOO_LARGE",
        channel_id: options.channelId,
        detail: `${file.name} (${String(file.size)} octets) au dessus de la limite.`,
      });
      return { path: null, skipReason: "too_large", size: 0 };
    }
    try {
      const binary = await options.api.downloadFile(file.id);
      const target = options.paths.attachmentFile(file.id, file.name);
      await writeBinary(target, binary.bytes);
      return { path: options.paths.relative(target), skipReason: undefined, size: binary.size };
    } catch (error) {
      warnings.push({
        code: "FILE_DOWNLOAD_FAILED",
        channel_id: options.channelId,
        detail: `${file.name} : ${error instanceof Error ? error.message : "erreur inconnue"}`,
      });
      return { path: null, skipReason: "download_failed", size: 0 };
    }
  }

  const pending = [...unique.values()];
  // Les pieces jointes dominent le nombre de requetes d une extraction et leur
  // taille est tres inegale. Une fenetre glissante garde la concurrence pleine,
  // la ou des tranches successives attendraient le plus gros fichier de chaque
  // tranche avec les autres connexions inutilisees.
  let done = 0;
  const results = await mapWithConcurrency(
    pending,
    options.downloadConcurrency ?? 1,
    async (file) => {
      const result = await fetchOne(file);
      done += 1;
      options.onProgress?.(done, pending.length, file.name);
      return result;
    },
  );

  const writer = await NdjsonWriter.open(options.paths.files, { append: true });
  try {
    for (const [position, file] of pending.entries()) {
      const result = results[position];
      if (result === undefined) continue;

      if (result.path === null) {
        skipped += 1;
      } else {
        downloaded += 1;
        bytes += result.size;
      }

      const record: ArchiveFile = {
        id: file.id,
        post_id: file.post_id,
        channel_id: options.channelId,
        user_id: file.user_id,
        name: file.name,
        extension: file.extension,
        size: file.size,
        mime_type: file.mime_type,
        width: file.width,
        height: file.height,
        has_preview_image: file.has_preview_image,
        create_at: file.create_at,
        delete_at: file.delete_at,
        path: result.path,
        ...(result.skipReason === undefined ? {} : { skip_reason: result.skipReason }),
      };
      await writer.write(record);
    }
  } finally {
    await writer.close();
  }

  return { downloaded, bytes, skipped, warnings };
}

export interface RepairFilesResult {
  readonly downloaded: number;
  readonly bytes: number;
  readonly described: number;
  readonly warnings: readonly ArchiveWarning[];
}

/**
 * Rattrape les pieces jointes citees par un message mais absentes de
 * files.ndjson.
 *
 * Ce trou apparaissait quand un canal etait marque termine avant l ecriture de
 * ses pieces jointes : la reprise l ignorait ensuite, et l archive gardait des
 * references vers le vide. La metadonnee est reconstruite depuis
 * GET /files/{id}/info, seule source disponible une fois les messages ecrits.
 */
export async function repairMissingFiles(
  options: AssetOptions & {
    missing: readonly { id: string; channelId: string }[];
    onProgress?: ((done: number, total: number) => void) | undefined;
  },
): Promise<RepairFilesResult> {
  const warnings: ArchiveWarning[] = [];
  let downloaded = 0;
  let bytes = 0;
  let done = 0;

  const records = await mapWithConcurrency(
    options.missing,
    options.downloadConcurrency ?? 1,
    async (entry): Promise<ArchiveFile | null> => {
      try {
        const info = await options.api.getFileInfo(entry.id);
        if (info === null) {
          warnings.push({
            code: "FILE_DOWNLOAD_FAILED",
            channel_id: entry.channelId,
            detail: `Metadonnee introuvable pour la piece jointe ${entry.id}.`,
          });
          return null;
        }

        let path: string | null = null;
        let skipReason: FileSkipReason | undefined;
        if (options.skipFiles) {
          skipReason = "skipped_by_option";
        } else if (info.size > options.maxFileSizeBytes) {
          skipReason = "too_large";
        } else {
          try {
            const binary = await options.api.downloadFile(entry.id);
            const target = options.paths.attachmentFile(entry.id, info.name);
            await writeBinary(target, binary.bytes);
            path = options.paths.relative(target);
            downloaded += 1;
            bytes += binary.size;
          } catch {
            skipReason = "download_failed";
          }
        }

        return {
          id: info.id,
          post_id: info.post_id,
          channel_id: entry.channelId,
          user_id: info.user_id,
          name: info.name,
          extension: info.extension,
          size: info.size,
          mime_type: info.mime_type,
          width: info.width,
          height: info.height,
          has_preview_image: info.has_preview_image,
          create_at: info.create_at,
          delete_at: info.delete_at,
          path,
          ...(skipReason === undefined ? {} : { skip_reason: skipReason }),
        };
      } catch (error) {
        warnings.push({
          code: "FILE_DOWNLOAD_FAILED",
          channel_id: entry.channelId,
          detail: `${entry.id} : ${error instanceof Error ? error.message : "erreur inconnue"}`,
        });
        return null;
      } finally {
        done += 1;
        options.onProgress?.(done, options.missing.length);
      }
    },
  );

  const found = records.filter((record): record is ArchiveFile => record !== null);
  if (found.length > 0) {
    const writer = await NdjsonWriter.open(options.paths.files, { append: true });
    try {
      await writer.writeMany(found);
    } finally {
      await writer.close();
    }
  }

  return { downloaded, bytes, described: found.length, warnings };
}
