import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArchiveChannel,
  archiveChannelSchema,
  archiveEmojiSchema,
  archiveFileSchema,
  archivePostSchema,
  archiveTeamSchema,
  archiveUserSchema,
  isPublicChannel,
  type Manifest,
  manifestSchema,
  SCHEMA_VERSION,
} from "@mmarchive/shared";
import { readNdjson } from "../archive/ndjson.js";
import { type ArchivePaths, createArchivePaths } from "../archive/paths.js";

export type Severity = "error" | "warning" | "info";

export interface CheckResult {
  readonly severity: Severity;
  readonly label: string;
  readonly detail?: string | undefined;
}

export interface VerifyReport {
  readonly results: readonly CheckResult[];
  readonly errors: number;
  readonly warnings: number;
}

export interface VerifyOptions {
  readonly archiveDir: string;
  /**
   * Verifie que chaque chemin declare existe reellement sur disque. Coute un
   * appel systeme par piece jointe et par avatar, soit des dizaines de milliers
   * sur une archive de production.
   */
  readonly checkBlobs?: boolean | undefined;
  readonly onProgress?: ((step: string, done?: number, total?: number) => void) | undefined;
}

interface Counters {
  posts: number;
  duplicates: number;
  unsortedChannels: number;
  orphanRoots: number;
  firstCreateAt: number;
  lastCreateAt: number;
}

/**
 * Verifie une archive sans rien modifier.
 *
 * Tous les controles se font en flux : a 1,9 million de messages, charger
 * l archive en memoire n est pas une option. Les seuls ensembles conserves sont
 * bornes par le nombre de canaux, d utilisateurs et de pieces jointes, jamais
 * par le nombre de messages.
 */
export async function verifyArchive(options: VerifyOptions): Promise<VerifyReport> {
  const paths = createArchivePaths(options.archiveDir);
  const results: CheckResult[] = [];
  const add = (severity: Severity, label: string, detail?: string): void => {
    results.push(detail === undefined ? { severity, label } : { severity, label, detail });
  };
  const report = (step: string, done?: number, total?: number): void => {
    options.onProgress?.(step, done, total);
  };

  report("manifeste");
  const manifest = await readManifest(paths, add);
  if (manifest === null) {
    return { results, errors: results.filter((r) => r.severity === "error").length, warnings: 0 };
  }

  report("collections");
  const channels = await checkChannels(paths, add);
  const userIds = await checkUsers(paths, add);
  const emojiCount = await countRecords(paths.emojis, archiveEmojiSchema, "emojis.ndjson", add);
  const teamCount = await countRecords(paths.teams, archiveTeamSchema, "teams.ndjson", add);
  const files = await checkFiles(paths, add);

  report("messages");
  const counters = await checkPosts(paths, channels, userIds, files.ids, add, report);

  if (options.checkBlobs === true) {
    report("binaires");
    await checkBlobs(paths, add, report);
  }

  report("coherence du manifeste");
  checkManifest(
    manifest,
    { channels, counters, userCount: userIds.size, emojiCount, teamCount, files },
    add,
  );

  return {
    results,
    errors: results.filter((r) => r.severity === "error").length,
    warnings: results.filter((r) => r.severity === "warning").length,
  };
}

async function readManifest(
  paths: ArchivePaths,
  add: (severity: Severity, label: string, detail?: string) => void,
): Promise<Manifest | null> {
  let raw: unknown;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = JSON.parse(await readFile(paths.manifest, "utf8"));
  } catch (error) {
    add(
      "error",
      "manifest.json lisible",
      error instanceof Error ? error.message : "fichier introuvable ou illisible",
    );
    return null;
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    add("error", "manifest.json conforme au schema", parsed.error.issues[0]?.message ?? "");
    return null;
  }
  add("info", "manifest.json conforme au schema");

  if (parsed.data.schema_version > SCHEMA_VERSION) {
    add(
      "error",
      "version de format lisible par cet outil",
      `l archive declare la version ${String(parsed.data.schema_version)}, cet outil connait la ${String(SCHEMA_VERSION)}`,
    );
  }
  return parsed.data;
}

async function countRecords(
  path: string,
  schema: { safeParse(value: unknown): { success: boolean } },
  label: string,
  add: (severity: Severity, label: string, detail?: string) => void,
): Promise<number> {
  let count = 0;
  let invalid = 0;
  try {
    for await (const record of readNdjson(path)) {
      count += 1;
      if (!schema.safeParse(record).success) invalid += 1;
    }
  } catch {
    add("warning", `${label} lisible`, "fichier absent");
    return 0;
  }
  if (invalid > 0) {
    add("error", `${label} conforme au schema`, `${String(invalid)} enregistrement(s) invalide(s)`);
  } else {
    add("info", `${label} : ${String(count)} enregistrements conformes`);
  }
  return count;
}

interface ChannelIndex {
  readonly byId: Map<string, ArchiveChannel>;
  readonly count: number;
}

async function checkChannels(
  paths: ArchivePaths,
  add: (severity: Severity, label: string, detail?: string) => void,
): Promise<ChannelIndex> {
  const byId = new Map<string, ArchiveChannel>();
  let invalid = 0;
  let nonPublic = 0;
  let duplicates = 0;

  try {
    for await (const record of readNdjson(paths.channels)) {
      const parsed = archiveChannelSchema.safeParse(record);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const channel = parsed.data;
      if (!isPublicChannel(channel)) nonPublic += 1;
      if (byId.has(channel.id)) duplicates += 1;
      byId.set(channel.id, channel);
    }
  } catch {
    add("error", "channels.ndjson lisible", "fichier absent");
    return { byId, count: 0 };
  }

  if (invalid > 0) {
    add("error", "channels.ndjson conforme au schema", `${String(invalid)} invalide(s)`);
  } else {
    add("info", `channels.ndjson : ${String(byId.size)} canaux conformes`);
  }
  // Garde-fou central du projet : aucune archive ne doit contenir de canal non public.
  if (nonPublic > 0) {
    add("error", "tous les canaux sont publics", `${String(nonPublic)} canal(aux) de type non O`);
  } else {
    add("info", "tous les canaux sont publics");
  }
  if (duplicates > 0) add("error", "aucun canal en double", `${String(duplicates)} doublon(s)`);

  return { byId, count: byId.size };
}

async function checkUsers(
  paths: ArchivePaths,
  add: (severity: Severity, label: string, detail?: string) => void,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let lines = 0;
  let invalid = 0;

  try {
    for await (const record of readNdjson(paths.users)) {
      lines += 1;
      const parsed = archiveUserSchema.safeParse(record);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      ids.add(parsed.data.id);
    }
  } catch {
    add("error", "users.ndjson lisible", "fichier absent");
    return ids;
  }

  if (invalid > 0) {
    add("error", "users.ndjson conforme au schema", `${String(invalid)} invalide(s)`);
  } else {
    add("info", `users.ndjson : ${String(lines)} enregistrements conformes`);
  }
  // Un annuaire en doublon a deja ete produit par une reprise mal persistee.
  if (lines !== ids.size) {
    add(
      "error",
      "aucun utilisateur en double",
      `${String(lines)} lignes pour ${String(ids.size)} identifiants distincts`,
    );
  }
  return ids;
}

interface FileIndex {
  readonly ids: Set<string>;
  readonly withBlob: number;
  readonly withoutBlob: number;
  readonly count: number;
}

async function checkFiles(
  paths: ArchivePaths,
  add: (severity: Severity, label: string, detail?: string) => void,
): Promise<FileIndex> {
  const ids = new Set<string>();
  let lines = 0;
  let invalid = 0;
  let withBlob = 0;
  let withoutBlob = 0;

  try {
    for await (const record of readNdjson(paths.files)) {
      lines += 1;
      const parsed = archiveFileSchema.safeParse(record);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      ids.add(parsed.data.id);
      if (parsed.data.path === null) withoutBlob += 1;
      else withBlob += 1;
    }
  } catch {
    add("warning", "files.ndjson lisible", "fichier absent");
    return { ids, withBlob: 0, withoutBlob: 0, count: 0 };
  }

  if (invalid > 0) {
    add("error", "files.ndjson conforme au schema", `${String(invalid)} invalide(s)`);
  } else {
    add("info", `files.ndjson : ${String(lines)} enregistrements conformes`);
  }
  if (lines !== ids.size) {
    add("error", "aucune piece jointe en double", `${String(lines - ids.size)} doublon(s)`);
  }
  if (withoutBlob > 0) {
    // Ce n est pas une anomalie : la metadonnee est conservee volontairement
    // quand le binaire manque, pour que le viewer puisse le signaler.
    add("info", `${String(withoutBlob)} piece(s) jointe(s) sans binaire, metadonnee conservee`);
  }
  return { ids, withBlob, withoutBlob, count: lines };
}

async function checkPosts(
  paths: ArchivePaths,
  channels: ChannelIndex,
  userIds: ReadonlySet<string>,
  fileIds: ReadonlySet<string>,
  add: (severity: Severity, label: string, detail?: string) => void,
  report: (step: string, done?: number, total?: number) => void,
): Promise<Counters> {
  const { readdir } = await import("node:fs/promises");
  const counters: Counters = {
    posts: 0,
    duplicates: 0,
    unsortedChannels: 0,
    orphanRoots: 0,
    firstCreateAt: Number.POSITIVE_INFINITY,
    lastCreateAt: 0,
  };

  let postFiles: string[];
  try {
    postFiles = (await readdir(join(paths.root, "posts"))).filter((name) =>
      name.endsWith(".ndjson"),
    );
  } catch {
    add("error", "repertoire posts/ lisible", "absent");
    return counters;
  }

  const missingAuthors = new Set<string>();
  const missingFiles = new Set<string>();
  const undescribed: string[] = [];
  let invalid = 0;

  let scanned = 0;
  for (const name of postFiles) {
    scanned += 1;
    report("messages", scanned, postFiles.length);
    const channelId = name.replace(/\.ndjson$/, "");
    if (!channels.byId.has(channelId)) undescribed.push(channelId);

    const ids = new Set<string>();
    const roots = new Set<string>();
    let previous = Number.NEGATIVE_INFINITY;
    let sorted = true;

    for await (const record of readNdjson(join(paths.root, "posts", name))) {
      const parsed = archivePostSchema.safeParse(record);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const post = parsed.data;
      counters.posts += 1;
      if (post.create_at < previous) sorted = false;
      previous = post.create_at;
      if (ids.has(post.id)) counters.duplicates += 1;
      ids.add(post.id);
      if (post.root_id.length > 0) roots.add(post.root_id);
      if (post.user_id.length > 0 && !userIds.has(post.user_id)) missingAuthors.add(post.user_id);
      for (const fileId of post.file_ids) {
        if (!fileIds.has(fileId)) missingFiles.add(fileId);
      }
      if (post.create_at > 0 && post.create_at < counters.firstCreateAt) {
        counters.firstCreateAt = post.create_at;
      }
      if (post.create_at > counters.lastCreateAt) counters.lastCreateAt = post.create_at;
    }

    if (!sorted) counters.unsortedChannels += 1;
    for (const root of roots) if (!ids.has(root)) counters.orphanRoots += 1;
  }

  if (invalid > 0) {
    add("error", "messages conformes au schema", `${String(invalid)} invalide(s)`);
  } else {
    add("info", `${String(postFiles.length)} fichiers de messages conformes`);
  }

  if (counters.unsortedChannels > 0) {
    add(
      "error",
      "messages tries par create_at croissant",
      `${String(counters.unsortedChannels)} fichier(s) mal tries`,
    );
  } else {
    add("info", `messages tries par create_at croissant (${String(counters.posts)} messages)`);
  }

  if (counters.duplicates > 0) {
    add("error", "aucun message en double", `${String(counters.duplicates)} doublon(s)`);
  } else {
    add("info", "aucun message en double");
  }

  if (missingAuthors.size > 0) {
    add(
      "error",
      "tout auteur a une fiche utilisateur",
      `${String(missingAuthors.size)} identifiant(s) sans fiche`,
    );
  } else {
    add("info", "tout auteur a une fiche utilisateur");
  }

  if (missingFiles.size > 0) {
    add(
      "error",
      "toute piece jointe referencee est decrite",
      `${String(missingFiles.size)} file_id absent(s) de files.ndjson`,
    );
  }

  if (undescribed.length > 0) {
    add(
      "error",
      "tout canal ayant des messages est decrit",
      `${String(undescribed.length)} canal(aux) sans entree dans channels.ndjson`,
    );
  } else {
    add("info", "tout canal ayant des messages est decrit");
  }

  if (counters.orphanRoots > 0) {
    // Legitime : la racine d un fil peut se trouver hors de la fenetre extraite,
    // ou dans un canal non selectionne. C est une information, pas une erreur.
    add(
      "info",
      `${String(counters.orphanRoots)} racine(s) de fil hors de l archive`,
      "attendu si l extraction est incrementale ou partielle",
    );
  }

  return counters;
}

async function checkBlobs(
  paths: ArchivePaths,
  add: (severity: Severity, label: string, detail?: string) => void,
  report: (step: string, done?: number, total?: number) => void,
): Promise<void> {
  let missing = 0;
  let present = 0;

  let seen = 0;
  for await (const record of readNdjson<{ path: string | null }>(paths.files)) {
    seen += 1;
    if (seen % 500 === 0) report("binaires", seen);
    if (record.path === null) continue;
    try {
      await stat(join(paths.root, record.path));
      present += 1;
    } catch {
      missing += 1;
    }
  }

  if (missing > 0) {
    add(
      "error",
      "chaque piece jointe declaree existe sur disque",
      `${String(missing)} fichier(s) manquant(s)`,
    );
  } else {
    add("info", `chaque piece jointe declaree existe sur disque (${String(present)})`);
  }
}

function checkManifest(
  manifest: Manifest,
  actual: {
    channels: ChannelIndex;
    counters: Counters;
    userCount: number;
    emojiCount: number;
    teamCount: number;
    files: FileIndex;
  },
  add: (severity: Severity, label: string, detail?: string) => void,
): void {
  const compare = (label: string, declared: number, real: number): void => {
    if (declared === real) {
      add("info", `${label} : ${String(real)}`);
      return;
    }
    add(
      "error",
      label,
      `le manifeste annonce ${String(declared)}, l archive contient ${String(real)}`,
    );
  };

  compare("counts.channels", manifest.counts.channels, actual.channels.count);
  compare("counts.posts", manifest.counts.posts, actual.counters.posts);
  compare("counts.users", manifest.counts.users, actual.userCount);
  compare("counts.emojis", manifest.counts.emojis, actual.emojiCount);
  compare("counts.teams", manifest.counts.teams, actual.teamCount);
  compare("counts.attachments", manifest.counts.attachments, actual.files.withBlob);

  if (manifest.post_range !== undefined && actual.counters.posts > 0) {
    const sameFirst = manifest.post_range.first_create_at === actual.counters.firstCreateAt;
    const sameLast = manifest.post_range.last_create_at === actual.counters.lastCreateAt;
    if (sameFirst && sameLast) add("info", "post_range coherent avec les messages");
    else add("error", "post_range coherent avec les messages");
  }

  // Tracabilite des effets de bord : ces deux chiffres doivent concorder, sinon
  // personne ne peut savoir ce que l outil a modifie sur l instance.
  if (manifest.selection.channels_joined_by_tool !== manifest.joined_channels.length) {
    add(
      "error",
      "les canaux rejoints sont traces nominativement",
      `selection annonce ${String(manifest.selection.channels_joined_by_tool)}, la liste en contient ${String(manifest.joined_channels.length)}`,
    );
  } else if (manifest.joined_channels.length === 0) {
    add("info", "aucun canal rejoint par l outil");
  } else {
    add(
      "info",
      `${String(manifest.joined_channels.length)} canal(aux) rejoints, traces nominativement`,
    );
  }

  // La completude doit rester auditable meme des annees plus tard.
  const total = manifest.selection.channels_total_public;
  if (total > 0 && actual.channels.count < total) {
    add(
      "info",
      `archive partielle : ${String(actual.channels.count)} canaux sur ${String(total)} publics`,
      "ecart normal si la selection etait volontairement restreinte",
    );
  }

  if (manifest.warnings.length > 0) {
    const byCode = new Map<string, number>();
    for (const warning of manifest.warnings) {
      byCode.set(warning.code, (byCode.get(warning.code) ?? 0) + 1);
    }
    const summary = [...byCode.entries()].map(([code, n]) => `${code} x${String(n)}`).join(", ");
    add("info", `${String(manifest.warnings.length)} avertissement(s) consignes`, summary);
  }
}
