import { rm } from "node:fs/promises";
import type { ArchivePost, ArchiveWarning, ChannelProgress } from "@mmarchive/shared";
import type { ArchivePaths } from "../archive/paths.js";
import { NdjsonWriter } from "../archive/ndjson.js";
import { reverseLines } from "../archive/reverse-file.js";
import type { MattermostApi } from "../mattermost/api.js";
import {
  normalizedHashtags,
  postsInOrder,
  type MmFileInfo,
  type MmPost,
} from "../mattermost/types.js";

export interface ChannelExtractionOptions {
  readonly api: MattermostApi;
  readonly channelId: string;
  readonly paths: ArchivePaths;
  readonly progress: ChannelProgress;
  /** Borne basse d une extraction incrementale, en millisecondes epoch. */
  readonly sinceMillis?: number | undefined;
  readonly perPage?: number | undefined;
  /** Ids des messages epingles, is_pinned n etant pas fiable sur les posts. */
  readonly pinnedIds?: ReadonlySet<string> | undefined;
  /** Appele apres chaque page ecrite, pour la barre de progression. */
  readonly onPage?: ((written: number, total: number) => void) | undefined;
  /** Persiste le curseur apres chaque page, pour que --resume soit fiable. */
  readonly onCursor?: ((patch: Partial<ChannelProgress>) => Promise<void>) | undefined;
}

export interface ChannelExtractionResult {
  readonly postsWritten: number;
  readonly firstCreateAt: number | null;
  readonly lastCreateAt: number | null;
  readonly userIds: ReadonlySet<string>;
  readonly files: readonly MmFileInfo[];
  readonly emojiNames: ReadonlySet<string>;
  readonly orphanRootIds: readonly string[];
  readonly warnings: readonly ArchiveWarning[];
}

function toArchivePost(post: MmPost, isPinned: boolean): ArchivePost {
  const reactions = post.metadata?.reactions ?? [];
  return {
    id: post.id,
    channel_id: post.channel_id,
    user_id: post.user_id,
    create_at: post.create_at,
    update_at: post.update_at,
    edit_at: post.edit_at,
    delete_at: post.delete_at,
    root_id: post.root_id,
    type: post.type,
    message: post.message,
    is_pinned: post.is_pinned ?? isPinned,
    hashtags: normalizedHashtags(post),
    props: post.props ?? {},
    file_ids: post.file_ids ?? [],
    reactions: reactions.map((reaction) => ({
      user_id: reaction.user_id,
      emoji_name: reaction.emoji_name,
      create_at: reaction.create_at,
    })),
  };
}

/**
 * Extrait l historique complet d un canal.
 *
 * L API pagine du plus RECENT vers le plus ANCIEN via le curseur before, alors
 * que le format d archive impose un tri par create_at croissant. On ecrit donc
 * au fil de l eau dans un fichier .part en ordre d arrivee, puis on l inverse en
 * flux a la finalisation. C est la seule facon de tenir a la fois "append au fil
 * de l eau" et "trie croissant" sans jamais charger le canal en memoire.
 */
export async function extractChannelPosts(
  options: ChannelExtractionOptions,
): Promise<ChannelExtractionResult> {
  const { api, channelId, paths, progress } = options;
  const partPath = paths.postsPartFile(channelId);
  const finalPath = paths.postsFile(channelId);
  const pinnedIds = options.pinnedIds ?? new Set<string>();

  const userIds = new Set<string>();
  const files: MmFileInfo[] = [];
  const emojiNames = new Set<string>();
  const rootIds = new Set<string>();
  const seenIds = new Set<string>();
  const warnings: ArchiveWarning[] = [];

  let cursor = progress.oldest_post_id;
  let written = progress.posts_written;
  let oldestCreateAt = progress.oldest_create_at;
  let newestCreateAt = progress.newest_create_at;
  let reachedSinceBound = false;

  const writer = await NdjsonWriter.open(partPath, { append: true });

  try {
    while (!reachedSinceBound) {
      const list = await api.getChannelPostsPage(channelId, {
        perPage: options.perPage,
        before: cursor ?? undefined,
      });

      const page = postsInOrder(list);
      if (page.length === 0) break;

      // Le sens de tri du tableau order n est PAS documente pour cet endpoint.
      // On ne suppose rien et on ordonne explicitement du plus recent au plus
      // ancien, ce qui est le sens d ecriture du fichier .part.
      page.sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id));

      // L inclusivite de before n est pas documentee non plus : le post pivot
      // peut revenir dans la page suivante. On deduplique donc toujours.
      const fresh = page.filter((post) => post.id !== cursor && !seenIds.has(post.id));

      const batch: ArchivePost[] = [];
      for (const post of fresh) {
        if (options.sinceMillis !== undefined && post.create_at < options.sinceMillis) {
          // Le parametre since de l API selectionne les posts MODIFIES, est
          // plafonne a 1000 et interdit la pagination. On l implemente donc
          // cote client, comme borne d arret de la remontee chronologique.
          reachedSinceBound = true;
          break;
        }
        seenIds.add(post.id);
        batch.push(toArchivePost(post, pinnedIds.has(post.id)));

        if (post.user_id.length > 0) userIds.add(post.user_id);
        if (post.root_id.length > 0) rootIds.add(post.root_id);
        for (const reaction of post.metadata?.reactions ?? []) {
          userIds.add(reaction.user_id);
          emojiNames.add(reaction.emoji_name);
        }
        for (const file of post.metadata?.files ?? []) files.push(file);
      }

      if (batch.length > 0) {
        await writer.writeMany(batch);
        await writer.flush();
        written += batch.length;

        const last = batch[batch.length - 1];
        const first = batch[0];
        if (last) {
          oldestCreateAt = last.create_at;
          cursor = last.id;
        }
        if (first && (newestCreateAt === null || first.create_at > newestCreateAt)) {
          newestCreateAt = first.create_at;
        }

        options.onPage?.(written, written);
        await options.onCursor?.({
          oldest_post_id: cursor,
          oldest_create_at: oldestCreateAt,
          newest_create_at: newestCreateAt,
          posts_written: written,
          status: "in_progress",
        });
      } else if (!reachedSinceBound) {
        // La page entiere etait deja connue et le curseur n a pas bouge :
        // continuer bouclerait indefiniment sur la meme requete.
        warnings.push({
          code: "CHANNEL_INCOMPLETE",
          channel_id: channelId,
          detail:
            "Pagination bloquee : une page complete n a apporte aucun message nouveau. Extraction du canal interrompue.",
        });
        break;
      }

      if (list.order.length === 0) break;
      if (list.prev_post_id !== undefined && list.prev_post_id === "") break;
    }
  } finally {
    await writer.close();
  }

  // Inversion en flux : le .part est en ordre decroissant, le format impose
  // l ordre croissant.
  await reverseLines(partPath, finalPath);
  await rm(partPath, { force: true });

  const orphanRootIds = [...rootIds].filter((rootId) => !seenIds.has(rootId));
  if (orphanRootIds.length > 0 && options.sinceMillis === undefined) {
    // Attendu en extraction incrementale, anormal sur un historique complet.
    warnings.push({
      code: "ORPHAN_THREAD_ROOT",
      channel_id: channelId,
      detail: `${String(orphanRootIds.length)} racine(s) de fil referencee(s) mais absente(s) du canal extrait.`,
    });
  }

  return {
    postsWritten: written,
    firstCreateAt: oldestCreateAt,
    lastCreateAt: newestCreateAt,
    userIds,
    files,
    emojiNames,
    orphanRootIds,
    warnings,
  };
}
