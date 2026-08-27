import { readdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ARCHIVE_LAYOUT,
  archiveChannelSchema,
  archiveEmojiSchema,
  archiveFileSchema,
  archivePostSchema,
  archiveUserSchema,
  assertPublicChannel,
  manifestSchema,
  SCHEMA_VERSION,
} from "@mmarchive/shared";
import { readNdjson } from "@mmarchive/shared/ndjson";
import {
  INDEX_DDL,
  INDEX_FTS,
  INDEX_INDEXES,
  INDEX_SCHEMA_VERSION,
  normalizeHashtag,
  POST_FLAGS,
  TAG_PREFIX,
} from "./schema.js";

const POSTS_EXTENSION = ".ndjson";

/** Une transaction par lot : a 1,9 million de lignes, une seule est trop longue a annuler. */
const BATCH_SIZE = 100_000;

export class IndexBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexBuildError";
  }
}

export type BuildStep =
  | "manifest"
  | "channels"
  | "users"
  | "emojis"
  | "posts"
  | "chronologie"
  | "fils"
  | "reactions"
  | "fichiers"
  | "ressources"
  | "recherche"
  | "compactage";

export interface BuildProgress {
  readonly step: BuildStep;
  readonly done: number;
  readonly total: number | undefined;
}

export interface BuildReport {
  readonly channels: number;
  readonly users: number;
  readonly emojis: number;
  readonly posts: number;
  readonly reactions: number;
  readonly files: number;
  /** Messages de bots et messages systeme, ecartes de l index. */
  readonly skippedNonHuman: number;
  /** Reponses dont la racine ne figure pas dans l index. */
  readonly orphanRoots: number;
  /** Canaux annonces par channels.ndjson dont le fichier de posts est absent. */
  readonly missingPostFiles: readonly string[];
  /** Fichiers de posts sans canal correspondant dans channels.ndjson. */
  readonly orphanPostFiles: readonly string[];
  /** Avatars et emojis copies dans l index. */
  readonly assets: number;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface BuildIndexOptions {
  readonly archiveRoot: string;
  readonly output: string;
  /** Ecrase un index existant. Sans ce drapeau, la construction refuse d ecraser. */
  readonly force?: boolean;
  /**
   * Copie avatars et emojis dans l index. Actif par defaut : sans eux, un index
   * ouvert depuis le disque ne peut afficher ni visage ni emoji personnalise,
   * faute de pouvoir charger le moindre fichier voisin.
   */
  readonly embedAssets?: boolean;
  readonly onProgress?: (progress: BuildProgress) => void;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * node:sqlite renvoie unknown : le cast est concentre ici plutot que disperse
 * sur chaque appel. Les requetes concernees sont des agregats ecrits juste au
 * dessus, leur forme est connue.
 */
function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  return typeof value === "number" ? value : 0;
}

async function readManifest(archiveRoot: string): Promise<number> {
  const path = join(archiveRoot, ARCHIVE_LAYOUT.manifest);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new IndexBuildError(
      `Manifeste illisible dans ${archiveRoot} : ${describeCause(cause)}. Le chemin designe-t-il bien une archive mmarchive ?`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new IndexBuildError(`Manifeste ${path} illisible : JSON invalide.`, { cause });
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new IndexBuildError(
      `Manifeste ${path} non conforme au format : ${result.error.issues[0]?.message ?? "structure inattendue"}.`,
    );
  }

  // Regle du format : un lecteur doit refuser une version majeure superieure a
  // celle qu il connait, et ignorer les champs inconnus plutot qu echouer.
  if (result.data.schema_version > SCHEMA_VERSION) {
    throw new IndexBuildError(
      `Archive en version de format ${String(result.data.schema_version)}, cet outil ne lit que la version ${String(SCHEMA_VERSION)}. Mettez le viewer a jour.`,
    );
  }
  return result.data.schema_version;
}

export async function buildIndex(options: BuildIndexOptions): Promise<BuildReport> {
  const started = Date.now();
  const { archiveRoot, output } = options;
  const report = (step: BuildStep, done: number, total?: number): void => {
    options.onProgress?.({ step, done, total });
  };

  report("manifest", 0);
  const archiveVersion = await readManifest(archiveRoot);
  report("manifest", 1, 1);

  if (await fileExists(output)) {
    if (!(options.force ?? false)) {
      throw new IndexBuildError(
        `L index ${output} existe deja. Relancez avec --force pour le remplacer : il est entierement reconstruit, jamais mis a jour.`,
      );
    }
    // Remplacement et non reouverture : rouvrir laisserait les tables de la
    // construction precedente, et un index a moitie ancien est pire qu absent.
    await rm(output, { force: true });
    await rm(`${output}-wal`, { force: true });
    await rm(`${output}-shm`, { force: true });
  }

  const db = new DatabaseSync(output);
  try {
    return await fill(db, options, report, started, archiveVersion);
  } catch (error) {
    // Un index interrompu en cours de construction est inutilisable, et le
    // laisser sur le disque ferait refuser la tentative suivante au motif qu un
    // index existe deja. Mieux vaut ne rien laisser que laisser un piege.
    db.close();
    await rm(output, { force: true });
    throw error;
  } finally {
    db.close();
  }
}

async function fill(
  db: DatabaseSync,
  options: BuildIndexOptions,
  report: (step: BuildStep, done: number, total?: number) => void,
  started: number,
  archiveVersion: number,
): Promise<BuildReport> {
  const { archiveRoot, output } = options;

  // journal_mode OFF et synchronous OFF : l index est un derive integralement
  // reconstruit, rien n a besoin de survivre a une coupure en cours de route.
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA page_size = 4096");
  db.exec(INDEX_DDL);
  db.exec(`
    CREATE TABLE staging (
      pid TEXT NOT NULL, ch INTEGER NOT NULL, usr INTEGER,
      create_at INTEGER NOT NULL, root_pid TEXT NOT NULL,
      flags INTEGER NOT NULL, message TEXT NOT NULL, hashtags TEXT NOT NULL
    );
    CREATE TABLE staging_reaction (
      post_pid TEXT NOT NULL, emoji TEXT NOT NULL, usr INTEGER, create_at INTEGER NOT NULL
    );
  `);

  const channelId = new Map<string, number>();
  const userId = new Map<string, number>();

  report("channels", 0);
  const insertChannel = db.prepare(
    "INSERT INTO channel (id, cid, name, display_name, purpose, header, create_at, delete_at, posts, first_at, last_at) VALUES (?,?,?,?,?,?,?,?,0,NULL,NULL)",
  );
  db.exec("BEGIN");
  for await (const raw of readNdjson(join(archiveRoot, ARCHIVE_LAYOUT.channels))) {
    const channel = archiveChannelSchema.parse(raw);
    // Filtre defensif : un canal non public ne doit pas pouvoir entrer dans un
    // index, meme via une archive bricolee a la main.
    assertPublicChannel(channel);
    const id = channelId.size + 1;
    channelId.set(channel.id, id);
    insertChannel.run(
      id,
      channel.id,
      channel.name,
      channel.display_name,
      channel.purpose,
      channel.header,
      channel.create_at,
      channel.delete_at,
    );
  }
  db.exec("COMMIT");
  report("channels", channelId.size, channelId.size);

  report("users", 0);
  const insertUser = db.prepare(
    "INSERT INTO user (id, uid, username, display, position, is_bot, delete_at, avatar) VALUES (?,?,?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  for await (const raw of readNdjson(join(archiveRoot, ARCHIVE_LAYOUT.users))) {
    const user = archiveUserSchema.parse(raw);
    const id = userId.size + 1;
    userId.set(user.id, id);
    const display =
      [user.first_name, user.last_name].filter((part) => part !== "").join(" ") ||
      user.nickname ||
      user.username;
    insertUser.run(
      id,
      user.id,
      user.username,
      display,
      user.position,
      user.is_bot ? 1 : 0,
      user.delete_at,
      user.avatar,
    );
  }
  db.exec("COMMIT");
  report("users", userId.size, userId.size);

  report("emojis", 0);
  let emojis = 0;
  const emojiPath = join(archiveRoot, ARCHIVE_LAYOUT.emojis);
  if (await fileExists(emojiPath)) {
    const insertEmoji = db.prepare("INSERT OR REPLACE INTO emoji (name, image) VALUES (?,?)");
    db.exec("BEGIN");
    for await (const raw of readNdjson(emojiPath)) {
      const emoji = archiveEmojiSchema.parse(raw);
      insertEmoji.run(emoji.name, emoji.image);
      emojis += 1;
    }
    db.exec("COMMIT");
  }
  report("emojis", emojis, emojis);

  const posts = await stagePosts(db, archiveRoot, channelId, userId, report);

  report("chronologie", 0);
  db.exec("CREATE INDEX staging_pid ON staging(pid)");
  // ROW_NUMBER plutot que l ordre d insertion implicite : l invariant
  // chronologique est trop central pour dependre d un comportement non ecrit.
  // Le tri secondaire sur pid rend la numerotation reproductible d une
  // construction a l autre, deux messages pouvant partager une milliseconde.
  db.exec(`
    INSERT INTO post (rowid, pid, ch, usr, create_at, root, flags)
    SELECT ROW_NUMBER() OVER (ORDER BY create_at, pid), pid, ch, usr, create_at, NULL, flags
    FROM staging
  `);
  db.exec(INDEX_INDEXES);
  db.exec(`
    INSERT INTO post_text (rowid, message)
    SELECT p.rowid, s.message FROM post p JOIN staging s ON s.pid = p.pid WHERE s.message <> ''
  `);
  report("chronologie", posts.kept, posts.kept);

  report("fils", 0);
  // La racine est resolue en SQL plutot qu en memoire : garder une table de
  // correspondance pour un million de racines serait un tampon global, ce que
  // la volumetrie cible interdit.
  db.exec(`
    UPDATE post SET root = r.rowid
    FROM staging s JOIN post r ON r.pid = s.root_pid
    WHERE s.pid = post.pid AND s.root_pid <> ''
  `);
  // Marquer les reponses deracinees, sans quoi root a NULL ne les distinguerait
  // plus d un message racine.
  db.exec(`
    UPDATE post SET flags = post.flags | ${String(POST_FLAGS.ORPHAN_ROOT)}
    FROM staging s
    WHERE s.pid = post.pid AND s.root_pid <> '' AND post.root IS NULL
  `);
  const orphanRoots = scalar(
    db,
    `SELECT count(*) FROM post WHERE flags & ${String(POST_FLAGS.ORPHAN_ROOT)} <> 0`,
  );
  report("fils", 1, 1);

  report("reactions", 0);
  db.exec(`
    INSERT INTO reaction (post, emoji, usr, create_at)
    SELECT p.rowid, r.emoji, r.usr, r.create_at FROM staging_reaction r JOIN post p ON p.pid = r.post_pid
  `);
  const reactions = scalar(db, "SELECT count(*) FROM reaction");
  report("reactions", reactions, reactions);

  const files = await loadFiles(db, archiveRoot, report);
  const assets = (options.embedAssets ?? true) ? await loadAssets(db, archiveRoot, report) : 0;

  report("recherche", 0);
  db.exec(INDEX_FTS);
  // Jointure a gauche : un message reduit a une piece jointe n a pas de texte,
  // mais il porte un canal et un auteur. L exclure le rendrait introuvable par
  // in: comme par from:, alors qu il existe bel et bien.
  db.exec(`
    INSERT INTO search (rowid, message, tag)
    SELECT p.rowid, COALESCE(t.message, ''),
           '${TAG_PREFIX.CHANNEL}' || p.ch || ' ${TAG_PREFIX.USER}' || COALESCE(p.usr, 0)
           || CASE WHEN s.hashtags = '' THEN '' ELSE ' ' || s.hashtags END
    FROM post p
    LEFT JOIN post_text t ON t.rowid = p.rowid
    JOIN staging s ON s.pid = p.pid
  `);
  db.exec("INSERT INTO search(search) VALUES('optimize')");
  report("recherche", posts.kept, posts.kept);

  db.exec(`
    UPDATE channel SET
      posts = (SELECT count(*) FROM post WHERE ch = channel.id),
      first_at = (SELECT min(create_at) FROM post WHERE ch = channel.id),
      last_at = (SELECT max(create_at) FROM post WHERE ch = channel.id)
  `);

  const insertMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)");
  insertMeta.run("index_schema_version", String(INDEX_SCHEMA_VERSION));
  // La version de l archive lue, pas la plus haute que cet outil sait lire :
  // le premier chiffre decrit l index produit, le second decrirait l outil.
  insertMeta.run("archive_schema_version", String(archiveVersion));
  insertMeta.run("built_at", new Date().toISOString());

  report("compactage", 0);
  db.exec("DROP TABLE staging");
  db.exec("DROP TABLE staging_reaction");
  db.exec("VACUUM");
  report("compactage", 1, 1);

  const bytes = (await stat(output)).size;
  return {
    channels: channelId.size,
    users: userId.size,
    emojis,
    posts: posts.kept,
    reactions,
    files,
    assets,
    skippedNonHuman: posts.skippedNonHuman,
    orphanRoots,
    missingPostFiles: posts.missingPostFiles,
    orphanPostFiles: posts.orphanPostFiles,
    bytes,
    durationMs: Date.now() - started,
  };
}

interface StageResult {
  readonly kept: number;
  readonly skippedNonHuman: number;
  readonly missingPostFiles: readonly string[];
  readonly orphanPostFiles: readonly string[];
}

async function stagePosts(
  db: DatabaseSync,
  archiveRoot: string,
  channelId: ReadonlyMap<string, number>,
  userId: ReadonlyMap<string, number>,
  report: (step: BuildStep, done: number, total?: number) => void,
): Promise<StageResult> {
  const postsDir = join(archiveRoot, ARCHIVE_LAYOUT.postsDir);
  const insertPost = db.prepare(
    "INSERT INTO staging (pid, ch, usr, create_at, root_pid, flags, message, hashtags) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insertReaction = db.prepare(
    "INSERT INTO staging_reaction (post_pid, emoji, usr, create_at) VALUES (?,?,?,?)",
  );

  const missingPostFiles: string[] = [];
  let kept = 0;
  let skippedNonHuman = 0;
  let pending = 0;

  report("posts", 0, undefined);
  db.exec("BEGIN");
  for (const [cid, ch] of channelId) {
    const path = join(postsDir, `${cid}${POSTS_EXTENSION}`);
    if (!(await fileExists(path))) {
      // Le format prevoit ce cas : un canal selectionne mais illisible n a pas
      // de fichier, et un warning correspondant figure dans le manifeste.
      missingPostFiles.push(cid);
      continue;
    }
    for await (const raw of readNdjson(path)) {
      const post = archivePostSchema.parse(raw);
      // Les messages de bots et les messages systeme restent dans l archive mais
      // n entrent pas dans l index : ils representent 31 % du volume et leur
      // contenu vit dans props, que le viewer n affiche pas.
      if (post.type !== "") {
        skippedNonHuman += 1;
        continue;
      }
      const flags =
        (post.edit_at !== 0 ? POST_FLAGS.EDITED : 0) |
        (post.is_pinned ? POST_FLAGS.PINNED : 0) |
        (post.file_ids.length > 0 ? POST_FLAGS.HAS_FILES : 0) |
        (post.reactions.length > 0 ? POST_FLAGS.HAS_REACTIONS : 0) |
        (post.delete_at !== 0 ? POST_FLAGS.DELETED : 0);
      const hashtags = post.hashtags
        .split(/\s+/)
        .map((tag) => normalizeHashtag(tag))
        .filter((tag) => tag !== "")
        .join(" ");
      insertPost.run(
        post.id,
        ch,
        userId.get(post.user_id) ?? null,
        post.create_at,
        post.root_id,
        flags,
        post.message,
        hashtags,
      );
      for (const reaction of post.reactions) {
        insertReaction.run(
          post.id,
          reaction.emoji_name,
          userId.get(reaction.user_id) ?? null,
          reaction.create_at,
        );
      }
      kept += 1;
      pending += 1;
      if (pending >= BATCH_SIZE) {
        db.exec("COMMIT");
        db.exec("BEGIN");
        pending = 0;
        report("posts", kept, undefined);
      }
    }
  }
  db.exec("COMMIT");
  report("posts", kept, kept);

  const orphanPostFiles: string[] = [];
  for (const entry of await readdir(postsDir).catch(() => [])) {
    if (!entry.endsWith(POSTS_EXTENSION)) continue;
    const cid = entry.slice(0, -POSTS_EXTENSION.length);
    if (!channelId.has(cid)) orphanPostFiles.push(cid);
  }

  return { kept, skippedNonHuman, missingPostFiles, orphanPostFiles };
}

const ASSET_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Copie avatars et emojis dans l index, en lisant chaque fichier a la demande.
 *
 * Le chemin vient de l archive : il est verifie avant lecture, faute de quoi une
 * archive bricolee ferait lire au builder n importe quel fichier du disque.
 */
async function loadAssets(
  db: DatabaseSync,
  archiveRoot: string,
  report: (step: BuildStep, done: number, total?: number) => void,
): Promise<number> {
  report("ressources", 0);
  const insert = db.prepare(
    "INSERT OR REPLACE INTO asset (kind, key, mime, blob) VALUES (?,?,?,?)",
  );
  const root = resolve(archiveRoot);
  let stored = 0;

  const copy = async (kind: string, key: string, relative: string): Promise<void> => {
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return;
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      // Un avatar annonce mais absent n est pas une anomalie : l extraction note
      // deja l echec dans le manifeste.
      return;
    }
    const extension = extname(target).toLowerCase();
    insert.run(kind, key, ASSET_MIME[extension] ?? "application/octet-stream", bytes);
    stored += 1;
  };

  db.exec("BEGIN");
  for (const row of db.prepare("SELECT uid, avatar FROM user WHERE avatar IS NOT NULL").all()) {
    const uid = row.uid;
    const avatar = row.avatar;
    if (typeof uid === "string" && typeof avatar === "string") await copy("avatar", uid, avatar);
    if (stored % 500 === 0) report("ressources", stored);
  }
  for (const row of db.prepare("SELECT name, image FROM emoji WHERE image IS NOT NULL").all()) {
    const name = row.name;
    const image = row.image;
    if (typeof name === "string" && typeof image === "string") await copy("emoji", name, image);
  }
  db.exec("COMMIT");
  report("ressources", stored, stored);
  return stored;
}

async function loadFiles(
  db: DatabaseSync,
  archiveRoot: string,
  report: (step: BuildStep, done: number, total?: number) => void,
): Promise<number> {
  report("fichiers", 0);
  const path = join(archiveRoot, ARCHIVE_LAYOUT.files);
  if (!(await fileExists(path))) {
    report("fichiers", 0, 0);
    return 0;
  }

  db.exec(`
    CREATE TABLE staging_file (
      fid TEXT NOT NULL, post_pid TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL,
      height INTEGER NOT NULL, path TEXT, skip_reason TEXT
    )
  `);
  const insert = db.prepare(
    "INSERT INTO staging_file (fid, post_pid, name, ext, size, mime, width, height, path, skip_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  let seen = 0;
  db.exec("BEGIN");
  for await (const raw of readNdjson(path)) {
    const file = archiveFileSchema.parse(raw);
    insert.run(
      file.id,
      file.post_id,
      file.name,
      file.extension,
      file.size,
      file.mime_type,
      file.width,
      file.height,
      file.path,
      file.skip_reason ?? null,
    );
    seen += 1;
  }
  db.exec("COMMIT");

  // Jointure sur post : une piece jointe attachee a un message de bot n a pas
  // de message correspondant dans l index et n a donc rien a y faire.
  db.exec(`
    INSERT INTO file (fid, post, name, ext, size, mime, width, height, path, skip_reason)
    SELECT f.fid, p.rowid, f.name, f.ext, f.size, f.mime, f.width, f.height, f.path, f.skip_reason
    FROM staging_file f JOIN post p ON p.pid = f.post_pid
  `);
  db.exec("DROP TABLE staging_file");
  const kept = scalar(db, "SELECT count(*) FROM file");
  report("fichiers", kept, seen);
  return kept;
}
