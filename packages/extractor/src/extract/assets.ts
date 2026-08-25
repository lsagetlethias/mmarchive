import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ArchiveEmoji,
  ArchiveFile,
  ArchiveUser,
  ArchiveWarning,
  FileSkipReason,
} from "@mmarchive/shared";
import { NdjsonWriter } from "../archive/ndjson.js";
import type { ArchivePaths } from "../archive/paths.js";
import type { MattermostApi } from "../mattermost/api.js";
import { isBotUser, type MmFileInfo, type MmUser } from "../mattermost/types.js";

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

/**
 * Applique un traitement par lots concurrents, en conservant l ordre des
 * resultats.
 *
 * Les telechargements sont domines par la latence : les enchainer un par un
 * laisse une seule requete en vol, quel que soit le debit autorise. Sur 762
 * emojis a 80 ms, la difference est d une minute.
 */
async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, batchSize);
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
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
  options: AssetOptions & { userIds: ReadonlySet<string>; alreadyDone: ReadonlySet<string> },
): Promise<UsersResult> {
  const warnings: ArchiveWarning[] = [];
  const pending = [...options.userIds].filter((id) => !options.alreadyDone.has(id));
  if (pending.length === 0) return { count: 0, warnings };

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
  const avatars = await mapInBatches(users, options.downloadConcurrency ?? 1, async (user) => {
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
  });

  const writer = await NdjsonWriter.open(options.paths.users, { append: true });
  try {
    for (const [index, user] of users.entries()) {
      const avatar = avatars[index] ?? null;

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
      await writer.write(record);
    }
  } finally {
    await writer.close();
  }

  return { count: users.length, warnings };
}

export interface EmojisResult {
  readonly count: number;
  readonly warnings: readonly ArchiveWarning[];
}

/**
 * Emojis personnalises de l instance. Necessaires au rendu des reactions : une
 * reaction ne reference qu un emoji_name, jamais une image.
 */
export async function extractEmojis(options: AssetOptions): Promise<EmojisResult> {
  const warnings: ArchiveWarning[] = [];
  let emojis;
  try {
    emojis = await options.api.getCustomEmojis();
  } catch (error) {
    warnings.push({
      code: "EMOJI_DOWNLOAD_FAILED",
      detail: `Liste des emojis personnalises indisponible : ${
        error instanceof Error ? error.message : "erreur inconnue"
      }`,
    });
    return { count: 0, warnings };
  }

  let done = 0;
  const images = await mapInBatches(emojis, options.downloadConcurrency ?? 1, async (emoji) => {
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
  });

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

  return { count: emojis.length, warnings };
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

  const writer = await NdjsonWriter.open(options.paths.files, { append: true });
  const pending = [...unique.values()];
  // Les pieces jointes representent l essentiel des requetes d une extraction,
  // et chacune est dominee par la latence reseau plutot que par le debit. Les
  // traiter par lots concurrents laisse plusieurs requetes en vol ; le limiteur
  // de debit reste le seul garde-fou du rythme reel.
  const batchSize = Math.max(1, options.downloadConcurrency ?? 1);
  let done = 0;
  try {
    for (let index = 0; index < pending.length; index += batchSize) {
      const batch = pending.slice(index, index + batchSize);
      const results = await Promise.all(batch.map(fetchOne));

      for (const [position, file] of batch.entries()) {
        const result = results[position];
        if (result === undefined) continue;
        done += 1;
        options.onProgress?.(done, pending.length, file.name);

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
    }
  } finally {
    await writer.close();
  }

  return { downloaded, bytes, skipped, warnings };
}
