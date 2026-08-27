import { createHash } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArchiveFile,
  type ArchivePost,
  type ArchiveUser,
  type Manifest,
  manifestSchema,
} from "@mmarchive/shared";
import { countNdjsonLines, NdjsonWriter, readNdjson } from "@mmarchive/shared/ndjson";
import { type ArchivePaths, createArchivePaths } from "../archive/paths.js";
import { Logger } from "../ui/logger.js";

export type RedactMode = "remove" | "pseudonymize";

/**
 * Identifiant de substitution stable : le meme utilisateur donne toujours le
 * meme pseudonyme, ce qui preserve la lisibilite des fils sans permettre de
 * remonter a l identite d origine.
 */
export function pseudonymFor(userId: string): string {
  return `anon-${createHash("sha256").update(userId).digest("hex").slice(0, 12)}`;
}

async function rewriteNdjson<T>(
  path: string,
  transform: (record: T) => T | null,
): Promise<{ kept: number; changed: number }> {
  const temporary = `${path}.redact`;
  let kept = 0;
  let changed = 0;
  const writer = await NdjsonWriter.open(temporary);
  try {
    for await (const record of readNdjson<T>(path)) {
      const next = transform(record);
      if (next === null) {
        changed += 1;
        continue;
      }
      if (next !== record) changed += 1;
      await writer.write(next);
      kept += 1;
    }
  } finally {
    await writer.close();
  }
  await rename(temporary, path);
  return { kept, changed };
}

export interface RedactResult {
  readonly postsRemoved: number;
  readonly postsRewritten: number;
  readonly reactionsRemoved: number;
  readonly userRemoved: boolean;
  /** Binaires de pieces jointes reellement effaces du disque. */
  readonly attachmentsDeleted: number;
}

export async function redactArchive(options: {
  archiveDir: string;
  userId: string;
  mode: RedactMode;
  logger?: Logger;
}): Promise<RedactResult> {
  const logger = options.logger ?? new Logger();
  const paths = createArchivePaths(options.archiveDir);
  const pseudonym = pseudonymFor(options.userId);

  let postsRemoved = 0;
  let postsRewritten = 0;
  let reactionsRemoved = 0;

  const postFiles = await readdir(paths.root === "" ? "posts" : join(paths.root, "posts"));
  for (const name of postFiles) {
    if (!name.endsWith(".ndjson")) continue;
    const path = join(paths.root, "posts", name);
    await rewriteNdjson<ArchivePost>(path, (post) => {
      const before = post.reactions.length;
      const reactions = post.reactions.filter((reaction) => reaction.user_id !== options.userId);
      reactionsRemoved += before - reactions.length;

      if (post.user_id === options.userId) {
        if (options.mode === "remove") {
          postsRemoved += 1;
          return null;
        }
        postsRewritten += 1;
        return { ...post, user_id: pseudonym, reactions };
      }
      if (reactions.length !== before) return { ...post, reactions };
      return post;
    });
  }

  let userRemoved = false;
  await rewriteNdjson<ArchiveUser>(paths.users, (user) => {
    if (user.id !== options.userId) return user;
    if (options.mode === "remove") {
      userRemoved = true;
      return null;
    }
    return {
      ...user,
      id: pseudonym,
      username: pseudonym,
      nickname: "",
      first_name: "",
      last_name: "",
      position: "",
      avatar: null,
    };
  });

  /**
   * Chemins des binaires a effacer.
   *
   * Une demande d effacement porte sur les donnees, pas sur l index qui les
   * decrit : retirer la ligne de files.ndjson en laissant le fichier sur disque
   * ne vaut pas effacement, et le document reste lisible par quiconque ouvre
   * l archive.
   */
  const attachmentsToDelete: string[] = [];
  await rewriteNdjson<ArchiveFile>(paths.files, (file) => {
    if (file.user_id !== options.userId) return file;
    if (options.mode === "remove") {
      if (file.path !== null) attachmentsToDelete.push(file.path);
      return null;
    }
    return { ...file, user_id: pseudonym };
  });

  let attachmentsDeleted = 0;
  for (const relative of attachmentsToDelete) {
    await rm(join(paths.root, relative), { force: true });
    attachmentsDeleted += 1;
  }

  // L avatar est un fichier a part : il ne disparait pas avec l enregistrement,
  // et aucun des deux modes ne doit le laisser derriere lui.
  await rm(paths.avatarFile(options.userId), { force: true });

  await refreshManifestCounts(paths);

  logger.info(
    `Mode ${options.mode} : ${String(postsRemoved)} messages supprimes, ${String(
      postsRewritten,
    )} pseudonymises, ${String(reactionsRemoved)} reactions retirees.`,
  );
  return { postsRemoved, postsRewritten, reactionsRemoved, userRemoved, attachmentsDeleted };
}

/**
 * Recale les compteurs du manifeste sur le contenu reel.
 *
 * Sans cela, une archive expurgee echoue a sa propre verification : il faudrait
 * choisir entre honorer une demande d effacement et conserver une archive
 * declaree coherente.
 */
async function refreshManifestCounts(paths: ArchivePaths): Promise<void> {
  let manifest: Manifest;
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.manifest, "utf8"));
    const result = manifestSchema.safeParse(parsed);
    if (!result.success) return;
    manifest = result.data;
  } catch {
    return;
  }

  const count = async (file: string): Promise<number> => {
    try {
      return await countNdjsonLines(file);
    } catch {
      return 0;
    }
  };

  let posts = 0;
  let first: number | null = null;
  let last: number | null = null;
  try {
    for (const name of await readdir(join(paths.root, "posts"))) {
      if (!name.endsWith(".ndjson")) continue;
      for await (const post of readNdjson<ArchivePost>(join(paths.root, "posts", name))) {
        posts += 1;
        if (post.create_at > 0 && (first === null || post.create_at < first))
          first = post.create_at;
        if (last === null || post.create_at > last) last = post.create_at;
      }
    }
  } catch {
    return;
  }

  let attachments = 0;
  let attachmentBytes = 0;
  try {
    for await (const file of readNdjson<ArchiveFile>(paths.files)) {
      if (file.path === null) continue;
      attachments += 1;
      attachmentBytes += file.size;
    }
  } catch {
    attachments = 0;
  }

  const updated: Manifest = {
    ...manifest,
    counts: {
      ...manifest.counts,
      posts,
      users: await count(paths.users),
      attachments,
      attachments_bytes: attachmentBytes,
    },
    ...(first === null || last === null
      ? {}
      : { post_range: { first_create_at: first, last_create_at: last } }),
  };
  await writeFile(paths.manifest, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}
