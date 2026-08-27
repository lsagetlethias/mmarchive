import { rm } from "node:fs/promises";
import type { ArchivePost, ArchiveWarning, ChannelProgress } from "@mmarchive/shared";
import { countNdjsonLines, NdjsonWriter, readNdjson } from "@mmarchive/shared/ndjson";
import type { ArchivePaths } from "../archive/paths.js";
import { reverseLines } from "../archive/reverse-file.js";
import type { MattermostApi } from "../mattermost/api.js";
import {
  type MmFileInfo,
  type MmPost,
  normalizedHashtags,
  postsInOrder,
} from "../mattermost/types.js";

/** Pages ecrites entre deux forcages sur disque. */
const FLUSH_EVERY_PAGES = 10;

export interface ChannelExtractionOptions {
  readonly api: MattermostApi;
  readonly channelId: string;
  readonly paths: ArchivePaths;
  readonly progress: ChannelProgress;
  /** Borne basse d une extraction incrementale, en millisecondes epoch. */
  readonly sinceMillis?: number | undefined;
  readonly perPage?: number | undefined;
  /**
   * Ids des messages epingles, is_pinned n etant pas fiable sur les posts.
   * Accepte une promesse : l appel peut etre lance en parallele de la premiere
   * page, il n est attendu qu au moment de convertir les posts.
   */
  readonly pinnedIds?: ReadonlySet<string> | Promise<ReadonlySet<string>> | undefined;
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

interface PartTail {
  readonly count: number;
  readonly lastId: string;
  readonly lastCreateAt: number;
  readonly firstCreateAt: number;
}

/**
 * Etat reel du fichier de travail d un canal : nombre de lignes et derniere
 * ligne ecrite. Renvoie null si le fichier n existe pas encore.
 *
 * Le .part est ecrit du plus recent au plus ancien : sa derniere ligne porte
 * donc le curseur de pagination a reprendre.
 */
async function readPartTail(partPath: string): Promise<PartTail | null> {
  let count = 0;
  let lastId = "";
  let lastCreateAt = 0;
  let firstCreateAt = 0;
  try {
    for await (const post of readNdjson<ArchivePost>(partPath)) {
      if (count === 0) firstCreateAt = post.create_at;
      count += 1;
      lastId = post.id;
      lastCreateAt = post.create_at;
    }
  } catch {
    // Absent ou illisible : on repart de l etat, qui est alors la seule source.
    return null;
  }
  if (count === 0) return null;
  return { count, lastId, lastCreateAt, firstCreateAt };
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
  const pinnedIdsPromise = Promise.resolve(options.pinnedIds ?? new Set<string>());

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

  /**
   * Le fichier de travail fait foi, pas l etat.
   *
   * L etat n est sauvegarde que periodiquement : apres un arret brutal, le .part
   * peut contenir des pages dont le curseur n a jamais ete enregistre. Repartir
   * du curseur de l etat rejouerait ces pages et ecrirait des doublons. On
   * recale donc le curseur sur la derniere ligne reellement presente.
   */
  const tail = await readPartTail(partPath);
  if (tail !== null && tail.count > 0) {
    cursor = tail.lastId;
    written = tail.count;
    oldestCreateAt = tail.lastCreateAt;
    newestCreateAt ??= tail.firstCreateAt;
  }

  let pagesSinceFlush = 0;
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

      const pinnedIds = await pinnedIdsPromise;
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
        pagesSinceFlush += 1;
        // Un fsync coute plus de dix fois le prix de l ecriture. Comme le .part
        // fait foi a la reprise, le forcer a chaque page n apporte rien : au
        // pire un arret brutal fait rejouer les dernieres pages non synchronisees.
        if (pagesSinceFlush >= FLUSH_EVERY_PAGES) {
          await writer.flush();
          pagesSinceFlush = 0;
        }
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

  /**
   * Inversion en flux : le .part est en ordre decroissant, le format impose
   * l ordre croissant.
   *
   * Garde-fou capital : on ne finalise QUE si le fichier de travail contient
   * quelque chose. Un canal dont les posts etaient deja finalises lors d une
   * session precedente n a plus de .part ; le recreer vide puis l inverser
   * tronquerait a zero le fichier final, deja complet. Mesure sur un cas
   * reproduit : 450 messages ramenes a 0, avec un manifeste qui en annoncait
   * toujours 450.
   */
  const partLines = await countNdjsonLines(partPath).catch(() => 0);
  if (partLines > 0) {
    await reverseLines(partPath, finalPath);
    await rm(partPath, { force: true });
  } else {
    await rm(partPath, { force: true });
    if (written > 0 && (await countNdjsonLines(finalPath).catch(() => 0)) === 0) {
      warnings.push({
        code: "CHANNEL_INCOMPLETE",
        channel_id: channelId,
        detail:
          "Le fichier de travail est vide alors que des messages etaient attendus : le canal doit etre reextrait.",
      });
    }
  }

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
