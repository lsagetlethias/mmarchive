import { createHash } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveFile, ArchivePost, ArchiveUser } from "@mmarchive/shared";
import { Command } from "commander";
import { NdjsonWriter, readNdjson } from "./archive/ndjson.js";
import { createArchivePaths } from "./archive/paths.js";
import { Logger } from "./ui/logger.js";
import { TOOL_VERSION } from "./version.js";

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

  await rewriteNdjson<ArchiveFile>(paths.files, (file) => {
    if (file.user_id !== options.userId) return file;
    if (options.mode === "remove") return null;
    return { ...file, user_id: pseudonym };
  });

  if (options.mode === "remove") {
    // L avatar est un fichier a part, il ne disparait pas avec l enregistrement.
    await rm(paths.avatarFile(options.userId), { force: true });
  }

  logger.info(
    `Mode ${options.mode} : ${String(postsRemoved)} messages supprimes, ${String(
      postsRewritten,
    )} pseudonymises, ${String(reactionsRemoved)} reactions retirees.`,
  );
  return { postsRemoved, postsRewritten, reactionsRemoved, userRemoved };
}

const program = new Command();
program
  .name("mmarchive-redact")
  .description("Honore une demande d effacement sur une archive deja produite.")
  .version(TOOL_VERSION)
  .requiredOption("--archive <dir>", "Repertoire de l archive")
  .requiredOption("--user <user_id>", "Identifiant de l utilisateur concerne")
  .requiredOption("--mode <mode>", "remove ou pseudonymize")
  .action(async (opts: { archive: string; user: string; mode: string }) => {
    const logger = new Logger();
    if (opts.mode !== "remove" && opts.mode !== "pseudonymize") {
      logger.error(`--mode doit valoir "remove" ou "pseudonymize", recu "${opts.mode}".`);
      process.exitCode = 2;
      return;
    }
    await redactArchive({
      archiveDir: opts.archive,
      userId: opts.user,
      mode: opts.mode,
      logger,
    });
    logger.warn("Une reindexation du viewer est necessaire apres cette operation.");
  });

await program.parseAsync(process.argv);
