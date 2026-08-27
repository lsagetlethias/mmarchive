import { POST_FLAGS } from "../index/schema.js";
import { num, numOrNull, type SqlDriver, type SqlRow, str, strOrNull } from "./driver.js";
import {
  type CompileOutcome,
  compileSearch,
  parseSearchQuery,
  type SearchResolver,
} from "./search-syntax.js";

export interface Channel {
  readonly id: number;
  readonly cid: string;
  readonly name: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly posts: number;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
  /** Archive au sens Mattermost : ferme, mais conserve. */
  readonly archived: boolean;
}

export interface User {
  readonly id: number;
  readonly uid: string;
  readonly username: string;
  readonly display: string;
  readonly position: string;
  readonly isBot: boolean;
  /** Compte desactive. Ses messages restent dans l archive. */
  readonly deactivated: boolean;
  readonly avatar: string | null;
}

export interface Message {
  readonly id: number;
  readonly pid: string;
  readonly channelId: number;
  readonly userId: number | null;
  readonly createAt: number;
  readonly rootId: number | null;
  readonly message: string;
  readonly edited: boolean;
  readonly pinned: boolean;
  readonly deleted: boolean;
  readonly hasFiles: boolean;
  readonly hasReactions: boolean;
  /** Reponse dont la racine est absente de l archive : le viewer doit le dire. */
  readonly orphanRoot: boolean;
}

export interface Reaction {
  readonly messageId: number;
  readonly emoji: string;
  readonly userId: number | null;
}

export interface Attachment {
  readonly messageId: number;
  readonly fid: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Chemin dans l archive, null si le binaire n a pas ete archive. */
  readonly path: string | null;
  /** Renseigne quand path vaut null : le viewer doit le dire, pas masquer. */
  readonly skipReason: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Curseur a repasser pour la page suivante, absent s il n y a plus rien. */
  readonly nextCursor: number | undefined;
}

const MESSAGE_COLUMNS =
  "p.rowid AS id, p.pid, p.ch, p.usr, p.create_at, p.root, p.flags, COALESCE(t.message, '') AS message";

const MESSAGE_FROM = "FROM post p LEFT JOIN post_text t ON t.rowid = p.rowid";

function toChannel(row: SqlRow): Channel {
  return {
    id: num(row, "id"),
    cid: str(row, "cid"),
    name: str(row, "name"),
    displayName: str(row, "display_name"),
    purpose: str(row, "purpose"),
    posts: num(row, "posts"),
    firstAt: numOrNull(row, "first_at"),
    lastAt: numOrNull(row, "last_at"),
    archived: num(row, "delete_at") !== 0,
  };
}

function toUser(row: SqlRow): User {
  return {
    id: num(row, "id"),
    uid: str(row, "uid"),
    username: str(row, "username"),
    display: str(row, "display"),
    position: str(row, "position"),
    isBot: num(row, "is_bot") !== 0,
    deactivated: num(row, "delete_at") !== 0,
    avatar: strOrNull(row, "avatar"),
  };
}

function toMessage(row: SqlRow): Message {
  const flags = num(row, "flags");
  return {
    id: num(row, "id"),
    pid: str(row, "pid"),
    channelId: num(row, "ch"),
    userId: numOrNull(row, "usr"),
    createAt: num(row, "create_at"),
    rootId: numOrNull(row, "root"),
    message: str(row, "message"),
    edited: (flags & POST_FLAGS.EDITED) !== 0,
    pinned: (flags & POST_FLAGS.PINNED) !== 0,
    deleted: (flags & POST_FLAGS.DELETED) !== 0,
    hasFiles: (flags & POST_FLAGS.HAS_FILES) !== 0,
    hasReactions: (flags & POST_FLAGS.HAS_REACTIONS) !== 0,
    orphanRoot: (flags & POST_FLAGS.ORPHAN_ROOT) !== 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Canaux et utilisateurs                                                      */
/* -------------------------------------------------------------------------- */

const CHANNEL_COLUMNS = "id, cid, name, display_name, purpose, posts, first_at, last_at, delete_at";

export function listChannels(
  driver: SqlDriver,
  options: { readonly includeEmpty?: boolean } = {},
): Channel[] {
  const where = (options.includeEmpty ?? false) ? "" : "WHERE posts > 0";
  return driver
    .all(`SELECT ${CHANNEL_COLUMNS} FROM channel ${where} ORDER BY last_at DESC, id`)
    .map(toChannel);
}

export function getChannel(driver: SqlDriver, id: number): Channel | undefined {
  const row = driver.get(`SELECT ${CHANNEL_COLUMNS} FROM channel WHERE id = ?`, [id]);
  return row === undefined ? undefined : toChannel(row);
}

export function getChannelByName(driver: SqlDriver, name: string): Channel | undefined {
  const row = driver.get(`SELECT ${CHANNEL_COLUMNS} FROM channel WHERE name = ?`, [name]);
  return row === undefined ? undefined : toChannel(row);
}

const USER_COLUMNS = "id, uid, username, display, position, is_bot, delete_at, avatar";

export function listUsers(driver: SqlDriver): User[] {
  return driver.all(`SELECT ${USER_COLUMNS} FROM user ORDER BY username`).map(toUser);
}

export function getUser(driver: SqlDriver, id: number): User | undefined {
  const row = driver.get(`SELECT ${USER_COLUMNS} FROM user WHERE id = ?`, [id]);
  return row === undefined ? undefined : toUser(row);
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export interface ChannelPageOptions {
  readonly limit?: number;
  /** Curseur exclusif : renvoie les messages plus anciens que celui ci. */
  readonly before?: number;
}

/**
 * Pagination par curseur sur le rowid, jamais par OFFSET : a plusieurs centaines
 * de milliers de messages, OFFSET fait relire toutes les lignes sautees.
 */
export function listChannelMessages(
  driver: SqlDriver,
  channelId: number,
  options: ChannelPageOptions = {},
): Page<Message> {
  const limit = options.limit ?? 50;
  const before = options.before;
  const rows = driver.all(
    `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
     WHERE p.ch = ?${before === undefined ? "" : " AND p.rowid < ?"}
     ORDER BY p.rowid DESC LIMIT ?`,
    before === undefined ? [channelId, limit + 1] : [channelId, before, limit + 1],
  );
  return paginate(rows.map(toMessage), limit);
}

function paginate(items: Message[], limit: number): Page<Message> {
  if (items.length <= limit) return { items, nextCursor: undefined };
  const page = items.slice(0, limit);
  return { items: page, nextCursor: page[page.length - 1]?.id };
}

export function getMessage(driver: SqlDriver, id: number): Message | undefined {
  const row = driver.get(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE p.rowid = ?`, [id]);
  return row === undefined ? undefined : toMessage(row);
}

/** Resolution d un permalien Mattermost, qui designe un message par son id d origine. */
export function getMessageByPid(driver: SqlDriver, pid: string): Message | undefined {
  const row = driver.get(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE p.pid = ?`, [pid]);
  return row === undefined ? undefined : toMessage(row);
}

/**
 * Fenetre centree sur un message, pour qu un permalien s ouvre dans son contexte
 * plutot que sur une ligne isolee.
 */
export function getMessageContext(
  driver: SqlDriver,
  id: number,
  around = 25,
): {
  readonly before: Message[];
  readonly message: Message | undefined;
  readonly after: Message[];
} {
  const message = getMessage(driver, id);
  if (message === undefined) return { before: [], message: undefined, after: [] };
  const before = driver
    .all(
      `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE p.ch = ? AND p.rowid < ? ORDER BY p.rowid DESC LIMIT ?`,
      [message.channelId, id, around],
    )
    .map(toMessage)
    .reverse();
  const after = driver
    .all(
      `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE p.ch = ? AND p.rowid > ? ORDER BY p.rowid LIMIT ?`,
      [message.channelId, id, around],
    )
    .map(toMessage);
  return { before, message, after };
}

/**
 * Un fil complet. La racine peut manquer : elle est parfois hors de la fenetre
 * extraite, ou portee par un message de bot que l index ne contient pas. Dans ce
 * cas les reponses existent sans racine, et le viewer doit le montrer plutot que
 * de faire disparaitre la conversation.
 */
export function getThread(
  driver: SqlDriver,
  rootId: number,
): { readonly root: Message | undefined; readonly replies: Message[] } {
  const root = getMessage(driver, rootId);
  const replies = driver
    .all(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE p.root = ? ORDER BY p.rowid`, [rootId])
    .map(toMessage);
  return { root, replies };
}

/* -------------------------------------------------------------------------- */
/* Reactions et pieces jointes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Les deux fonctions prennent une plage de rowid plutot qu une liste : les
 * messages affiches sont contigus par construction, et une plage se lit en
 * quelques pages la ou une liste de cinquante identifiants en coute autant que
 * de messages.
 */
export function listReactions(driver: SqlDriver, fromId: number, toId: number): Reaction[] {
  return driver
    .all("SELECT post, emoji, usr FROM reaction WHERE post BETWEEN ? AND ? ORDER BY post", [
      fromId,
      toId,
    ])
    .map((row) => ({
      messageId: num(row, "post"),
      emoji: str(row, "emoji"),
      userId: numOrNull(row, "usr"),
    }));
}

/**
 * Nombre de reponses par racine, pour les messages d une page.
 *
 * Une liste d identifiants plutot qu une plage : les reponses d un fil peuvent
 * se trouver n importe ou apres leur racine, parfois des mois plus tard, et une
 * plage couvrirait alors la moitie de l archive.
 */
export function listReplyCounts(
  driver: SqlDriver,
  rootIds: readonly number[],
): Map<number, number> {
  const counts = new Map<number, number>();
  if (rootIds.length === 0) return counts;
  const placeholders = rootIds.map(() => "?").join(",");
  const rows = driver.all(
    `SELECT root, count(*) AS n FROM post WHERE root IN (${placeholders}) GROUP BY root`,
    [...rootIds],
  );
  for (const row of rows) counts.set(num(row, "root"), num(row, "n"));
  return counts;
}

export function listAttachments(driver: SqlDriver, fromId: number, toId: number): Attachment[] {
  return driver
    .all(
      `SELECT post, fid, name, ext, size, mime, width, height, path, skip_reason
       FROM file WHERE post BETWEEN ? AND ? ORDER BY post, id`,
      [fromId, toId],
    )
    .map((row) => ({
      messageId: num(row, "post"),
      fid: str(row, "fid"),
      name: str(row, "name"),
      extension: str(row, "ext"),
      size: num(row, "size"),
      mime: str(row, "mime"),
      width: num(row, "width"),
      height: num(row, "height"),
      path: strOrNull(row, "path"),
      skipReason: strOrNull(row, "skip_reason"),
    }));
}

/* -------------------------------------------------------------------------- */
/* Recherche                                                                   */
/* -------------------------------------------------------------------------- */

export type SearchResult =
  | { readonly kind: "ok"; readonly page: Page<Message>; readonly expression: string }
  | { readonly kind: "vide" }
  | { readonly kind: "sans-terme-positif" }
  | { readonly kind: "introuvable"; readonly names: readonly string[] };

export interface SearchOptions {
  readonly limit?: number;
  readonly before?: number;
  /** Decalage du fuseau du lecteur, en minutes, pour les bornes de dates. */
  readonly timeZoneOffsetMinutes?: number;
}

export function createResolver(driver: SqlDriver): SearchResolver {
  return {
    channelIdByName(name) {
      const row = driver.get("SELECT id FROM channel WHERE name = ?", [name]);
      return row === undefined ? undefined : num(row, "id");
    },
    userIdByUsername(username) {
      const row = driver.get("SELECT id FROM user WHERE username = ?", [username]);
      return row === undefined ? undefined : num(row, "id");
    },
  };
}

/**
 * Traduit un instant en rowid par dichotomie, en s appuyant sur l ordre
 * chronologique du rowid. Une vingtaine de lectures suffisent pour 1,3 million
 * de messages, ce qui evite d avoir a porter un index sur create_at : ce dernier
 * couterait 27 Mo et ne servirait qu ici.
 */
export function rowidAtOrAfter(driver: SqlDriver, timeMs: number): number {
  const maxRow = driver.get("SELECT max(rowid) AS m FROM post");
  const max = maxRow === undefined ? 0 : (numOrNull(maxRow, "m") ?? 0);
  let low = 1;
  let high = max + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = driver.get("SELECT create_at FROM post WHERE rowid = ?", [middle]);
    // Un rowid absent ne peut pas arriver sur un index sain, mais le supposer
    // ferait boucler la dichotomie au lieu de la faire converger.
    const at = row === undefined ? Number.MAX_SAFE_INTEGER : num(row, "create_at");
    if (at >= timeMs) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function searchMessages(
  driver: SqlDriver,
  input: string,
  options: SearchOptions = {},
): SearchResult {
  const parsed = parseSearchQuery(input);
  const outcome: CompileOutcome = compileSearch(
    parsed,
    createResolver(driver),
    options.timeZoneOffsetMinutes ?? 0,
  );
  if (outcome.kind !== "ok") return outcome;

  const limit = options.limit ?? 50;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (outcome.match !== "") {
    conditions.push("s.search MATCH ?");
    params.push(outcome.match);
  }
  if (outcome.range.fromMs !== undefined) {
    conditions.push("s.rowid >= ?");
    params.push(rowidAtOrAfter(driver, outcome.range.fromMs));
  }
  if (outcome.range.toMs !== undefined) {
    // Borne haute exclusive : le premier message strictement apres la fin.
    conditions.push("s.rowid < ?");
    params.push(rowidAtOrAfter(driver, outcome.range.toMs + 1));
  }
  if (options.before !== undefined) {
    conditions.push("s.rowid < ?");
    params.push(options.before);
  }
  params.push(limit + 1);

  // ORDER BY rowid, jamais create_at : les deux ordres sont equivalents mais
  // SQLite l ignore, et trier sur la date lui fait relire la date de chaque
  // resultat, soit 10 836 pages au lieu de 66 sur l archive de reference.
  const rows = driver.all(
    `SELECT ${MESSAGE_COLUMNS} FROM search s
     JOIN post p ON p.rowid = s.rowid
     LEFT JOIN post_text t ON t.rowid = s.rowid
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.rowid DESC LIMIT ?`,
    params,
  );
  return { kind: "ok", page: paginate(rows.map(toMessage), limit), expression: outcome.match };
}
