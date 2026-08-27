import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { INDEX_SCHEMA_VERSION } from "../../../src/index/schema.js";
import type { SqlDriver, SqlRow, SqlValue } from "../../../src/query/driver.js";
import {
  getChannel,
  getMessage,
  getMessageByPid,
  getMessageContext,
  getThread,
  listAttachments,
  listChannelMessages,
  listChannels,
  listReactions,
  listReplyCounts,
  listUsers,
  type Message,
  searchMessages,
} from "../../../src/query/queries.js";
import { createFileBackend, createHttpBackend } from "./backends.js";
import { BlockCache } from "./block-cache.js";
import { installReadOnlyVfs, LITE_VFS_NAME, type SqliteDb, type SqliteWasm } from "./vfs.js";

export type WorkerRequest =
  | { readonly id: number; readonly kind: "ouvrir-fichier"; readonly file: File }
  | { readonly id: number; readonly kind: "ouvrir-url"; readonly url: string }
  | {
      readonly id: number;
      readonly kind: "appel";
      readonly method: string;
      readonly args: unknown[];
    };

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

let cache: BlockCache | undefined;
let db: SqliteDb | undefined;

/**
 * Pilote identique en tout point a celui du mode serveur, aux appels SQLite
 * pres. C est la seule piece a reecrire pour le mode sans serveur : les
 * requetes, elles, sont exactement les memes fonctions.
 */
function createDriver(database: SqliteDb): SqlDriver {
  const run = (sql: string, params: readonly SqlValue[]): SqlRow[] => {
    const rows: SqlRow[] = [];
    database.exec({
      sql,
      bind: [...params],
      rowMode: "object",
      callback: (row: unknown) => {
        rows.push(row as SqlRow);
      },
    });
    return rows;
  };
  return {
    all: (sql, params = []) => run(sql, params),
    get: (sql, params = []) => run(sql, params)[0],
    close: () => {
      database.close();
    },
  };
}

let driver: SqlDriver | undefined;

/**
 * Binaire WebAssembly fourni par le bundle autonome.
 *
 * Ouverte depuis un disque, une page ne peut emettre aucune requete : le moteur
 * ne peut donc pas aller chercher son propre .wasm et doit le recevoir tout
 * cuit. Servi par un serveur, ce global est absent et le chargement habituel
 * reprend la main.
 */
declare const __MMARCHIVE_WASM__: Uint8Array | undefined;

function inlinedWasm(): Uint8Array | undefined {
  return typeof __MMARCHIVE_WASM__ === "undefined" ? undefined : __MMARCHIVE_WASM__;
}

async function open(makeCache: () => BlockCache): Promise<{ label: string }> {
  // Deux ouvertures successives reinstalleraient le VFS sous le meme nom et
  // laisseraient la premiere base ouverte sur un cache qui n est plus le sien.
  if (db !== undefined) {
    throw new Error(
      "Un index est deja ouvert dans cette page. Rechargez la pour en ouvrir un autre.",
    );
  }
  const wasmBinary = inlinedWasm();
  // Le typage publie n annonce aucun parametre, alors que le module Emscripten
  // accepte la configuration habituelle, wasmBinary compris.
  const load = sqlite3InitModule as unknown as (
    config?: Record<string, unknown>,
  ) => Promise<unknown>;
  const sqlite3 = (await load(wasmBinary === undefined ? {} : { wasmBinary })) as SqliteWasm;
  installReadOnlyVfs(sqlite3, () => cache);
  cache = makeCache();
  db = new sqlite3.oo1.DB({ filename: "index.db", flags: "r", vfs: LITE_VFS_NAME });
  driver = createDriver(db);

  const version = driver.get("SELECT value FROM meta WHERE key = 'index_schema_version'");
  const found = version === undefined ? undefined : Number(version.value);
  if (found !== INDEX_SCHEMA_VERSION) {
    throw new Error(
      `Cet index est en version ${String(found ?? "inconnue")}, ce viewer attend la version ${String(INDEX_SCHEMA_VERSION)}. Reconstruisez le avec mmarchive-index : c est un derive de l archive, l operation prend une minute.`,
    );
  }
  return { label: "ouvert" };
}

function withDetails(messages: readonly Message[], nextCursor: number | undefined): unknown {
  if (driver === undefined) throw new Error("Index non ouvert.");
  if (messages.length === 0) {
    return { messages: [], reactions: [], attachments: [], replyCounts: {}, nextCursor: null };
  }
  const ids = messages.map((message) => message.id);
  const from = Math.min(...ids);
  const to = Math.max(...ids);
  return {
    messages,
    reactions: listReactions(driver, from, to),
    attachments: listAttachments(driver, from, to),
    replyCounts: Object.fromEntries(listReplyCounts(driver, ids)),
    nextCursor: nextCursor ?? null,
  };
}

interface PageArgs {
  readonly limit?: number;
  readonly before?: number;
}

function pageOptions(options: PageArgs | undefined): { limit?: number; before?: number } {
  return {
    ...(options?.limit === undefined ? {} : { limit: options.limit }),
    ...(options?.before === undefined ? {} : { before: options.before }),
  };
}

/**
 * Les memes fonctions de requete que le serveur, appelees ici dans le worker.
 * Aucune n a ete adaptee : c est tout l interet d avoir garde la couche de
 * requetes synchrone et ignorante de son transport.
 */
function call(method: string, args: unknown[]): unknown {
  if (driver === undefined) throw new Error("Index non ouvert.");
  switch (method) {
    case "meta": {
      const counts = driver.get(
        "SELECT (SELECT count(*) FROM post) AS posts, (SELECT count(*) FROM channel WHERE posts > 0) AS channels, (SELECT count(*) FROM user) AS users",
      );
      const builtAt = driver.get("SELECT value FROM meta WHERE key = 'built_at'");
      return {
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        builtAt: builtAt === undefined ? null : String(builtAt.value),
        counts: {
          posts: Number(counts?.posts ?? 0),
          channels: Number(counts?.channels ?? 0),
          users: Number(counts?.users ?? 0),
        },
      };
    }
    case "channels":
      return listChannels(driver);
    case "users":
      return listUsers(driver);
    case "customEmojis":
      return driver
        .all("SELECT name FROM emoji WHERE image IS NOT NULL ORDER BY name")
        .map((row) => String(row.name));
    case "channelMessages": {
      const page = listChannelMessages(driver, Number(args[0]), pageOptions(args[1] as PageArgs));
      return withDetails(page.items, page.nextCursor);
    }
    case "messageContext": {
      const context = getMessageContext(driver, Number(args[0]));
      if (context.message === undefined) throw new Error("Message inconnu.");
      const all = [...context.before, context.message, ...context.after];
      return { ...(withDetails(all, undefined) as object), focus: context.message.id };
    }
    case "thread": {
      const thread = getThread(driver, Number(args[0]));
      const all = thread.root === undefined ? thread.replies : [thread.root, ...thread.replies];
      return withDetails(all, undefined);
    }
    case "search": {
      const options = args[1] as PageArgs & { timeZoneOffsetMinutes?: number };
      const result = searchMessages(driver, String(args[0]), {
        ...pageOptions(options),
        ...(options?.timeZoneOffsetMinutes === undefined
          ? {}
          : { timeZoneOffsetMinutes: options.timeZoneOffsetMinutes }),
      });
      if (result.kind !== "ok") {
        return result.kind === "introuvable"
          ? { status: "introuvable", names: result.names }
          : { status: result.kind };
      }
      return {
        status: "ok",
        ...(withDetails(result.page.items, result.page.nextCursor) as object),
      };
    }
    case "permalink":
      return getMessageByPid(driver, String(args[0])) ?? null;
    case "message":
      return getMessage(driver, Number(args[0])) ?? null;
    case "channel":
      return getChannel(driver, Number(args[0])) ?? null;
    case "asset":
      return readAsset(driver, String(args[0]), String(args[1]));
    case "tous-emojis": {
      // Les emojis personnalises sont resolus en bloc : ils apparaissent dans le
      // corps des messages, ou le rendu produit du balisage et ne peut pas
      // attendre une resolution asynchrone par image.
      const out: Record<string, { bytes: Uint8Array; mime: string }> = {};
      for (const row of driver.all("SELECT key, mime, blob FROM asset WHERE kind = 'emoji'")) {
        const key = row.key;
        const blob = row.blob;
        if (typeof key === "string" && blob instanceof Uint8Array) {
          out[key] = { bytes: blob, mime: typeof row.mime === "string" ? row.mime : "image/png" };
        }
      }
      return out;
    }
    default:
      throw new Error(`Methode inconnue : ${method}`);
  }
}

/**
 * Avatars, emojis et pieces jointes vivent dans l index lui meme en mode sans
 * serveur : une page ouverte depuis le disque ne peut charger aucun fichier
 * voisin, pas meme celui d a cote.
 */
function readAsset(source: SqlDriver, kind: string, key: string): unknown {
  const row =
    kind === "avatar"
      ? source.get("SELECT blob, mime FROM asset WHERE kind = 'avatar' AND key = ?", [key])
      : source.get("SELECT blob, mime FROM asset WHERE kind = ? AND key = ?", [kind, key]);
  if (row === undefined) return null;
  const blob = row.blob;
  if (!(blob instanceof Uint8Array)) return null;
  return {
    bytes: blob,
    mime: typeof row.mime === "string" ? row.mime : "application/octet-stream",
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  const reply = (response: WorkerResponse): void => {
    self.postMessage(response);
  };

  const fail = (error: unknown): void => {
    reply({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "erreur inattendue",
    });
  };

  try {
    if (request.kind === "appel") {
      reply({ id: request.id, ok: true, value: call(request.method, request.args) });
      return;
    }
    const makeCache =
      request.kind === "ouvrir-fichier"
        ? () => new BlockCache(createFileBackend(request.file))
        : () => new BlockCache(createHttpBackend(request.url));
    open(makeCache)
      .then((value) => {
        reply({ id: request.id, ok: true, value });
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
};
