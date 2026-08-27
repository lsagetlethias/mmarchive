import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { INDEX_SCHEMA_VERSION } from "../index/schema.js";
import { num, type SqlDriver, str } from "../query/driver.js";
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
} from "../query/queries.js";
import { contentDisposition, resolveArchivePath, UnsafeArchivePathError } from "./archive-files.js";

export interface ViewerServerOptions {
  readonly driver: SqlDriver;
  /** Racine de l archive, pour servir pieces jointes, avatars et emojis. */
  readonly archiveRoot: string;
  /** Frontend construit. Absent, le serveur n expose que l API. */
  readonly webRoot?: string | undefined;
  readonly logger?: boolean;
}

const MAX_LIMIT = 200;

const idParam = z.object({ id: z.coerce.number().int().positive() });
const pageQuery = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const searchQuery = pageQuery.extend({
  q: z.string().default(""),
  /** Decalage du fuseau du lecteur, en minutes, pour les bornes de dates. */
  tz: z.coerce.number().int().min(-840).max(840).optional(),
});

function pageOptions(query: z.infer<typeof pageQuery>): { limit?: number; before?: number } {
  // Les proprietes optionnelles sont omises et non posees a undefined :
  // exactOptionalPropertyTypes distingue les deux.
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.before === undefined ? {} : { before: query.before }),
  };
}

/**
 * Enveloppe une page de messages avec ses reactions et ses pieces jointes.
 *
 * Les trois voyagent ensemble parce qu elles se lisent ensemble : laisser le
 * client les demander message par message ferait cinquante appels la ou une
 * plage de rowid s obtient en une requete et quelques pages lues.
 */
function withDetails(driver: SqlDriver, messages: readonly Message[]): Record<string, unknown> {
  if (messages.length === 0) {
    return { messages: [], reactions: [], attachments: [] };
  }
  const ids = messages.map((message) => message.id);
  const from = Math.min(...ids);
  const to = Math.max(...ids);
  return {
    messages,
    reactions: listReactions(driver, from, to),
    attachments: listAttachments(driver, from, to),
    replyCounts: Object.fromEntries(listReplyCounts(driver, ids)),
  };
}

export function createServer(options: ViewerServerOptions): FastifyInstance {
  const { driver } = options;
  // @fastify/static exige une racine absolue, et l appelant vient de la ligne de
  // commande ou "./archive" est la forme naturelle.
  const archiveRoot = resolve(options.archiveRoot);
  const app = Fastify({ logger: options.logger ?? false });

  /**
   * Lecture seule integrale, verifiee a l execution et pas seulement par
   * l absence de routes : c est le pendant cote viewer de la porte de
   * consentement de l extracteur. Aucune requete autre que GET ou HEAD ne doit
   * pouvoir atteindre un gestionnaire, meme si une route d ecriture etait
   * ajoutee un jour par inadvertance.
   */
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      await reply
        .code(405)
        .header("allow", "GET, HEAD")
        .send({ error: "Ce viewer est en lecture seule." });
    }
  });

  /**
   * Une saisie invalide est une erreur du client, pas du serveur : sans ce
   * traitement, un parametre hors bornes remonte en 500 et se lit comme une
   * panne alors que la requete est simplement a corriger.
   */
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      void reply.code(400).send({
        error: "Parametre invalide.",
        detail: first === undefined ? undefined : `${first.path.join(".")} : ${first.message}`,
      });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({ error: "Erreur interne." });
  });

  app.addHook("onSend", async (_request, reply) => {
    // Les contenus servis viennent de tiers : interdire le reniflage de type
    // evite qu un fichier televerse soit interprete autrement qu annonce.
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("referrer-policy", "no-referrer");
    // Defense en profondeur du rendu des messages : meme si un balisage
    // parvenait a traverser l echappement puis l assainissement, aucun script
    // ne s executerait et aucune donnee ne partirait vers un tiers.
    void reply.header(
      "content-security-policy",
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
  });

  app.register(fastifyStatic, { root: archiveRoot, serve: false });

  app.get("/api/meta", () => {
    const counts = driver.get(
      "SELECT (SELECT count(*) FROM post) AS posts, (SELECT count(*) FROM channel WHERE posts > 0) AS channels, (SELECT count(*) FROM user) AS users",
    );
    const builtAt = driver.get("SELECT value FROM meta WHERE key = 'built_at'");
    return {
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      builtAt: builtAt === undefined ? null : str(builtAt, "value"),
      counts:
        counts === undefined
          ? null
          : {
              posts: num(counts, "posts"),
              channels: num(counts, "channels"),
              users: num(counts, "users"),
            },
    };
  });

  app.get("/api/channels", () => ({ channels: listChannels(driver) }));

  app.get("/api/channels/:id", (request, reply) => {
    const { id } = idParam.parse(request.params);
    const channel = getChannel(driver, id);
    if (channel === undefined) return reply.code(404).send({ error: "Canal inconnu." });
    return { channel };
  });

  app.get("/api/channels/:id/messages", (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (getChannel(driver, id) === undefined) {
      return reply.code(404).send({ error: "Canal inconnu." });
    }
    const query = pageQuery.parse(request.query);
    const page = listChannelMessages(driver, id, pageOptions(query));
    return { ...withDetails(driver, page.items), nextCursor: page.nextCursor ?? null };
  });

  app.get("/api/messages/:id", (request, reply) => {
    const { id } = idParam.parse(request.params);
    const message = getMessage(driver, id);
    if (message === undefined) return reply.code(404).send({ error: "Message inconnu." });
    return { message };
  });

  app.get("/api/messages/:id/context", (request, reply) => {
    const { id } = idParam.parse(request.params);
    const context = getMessageContext(driver, id);
    if (context.message === undefined) {
      return reply.code(404).send({ error: "Message inconnu." });
    }
    const all = [...context.before, context.message, ...context.after];
    return {
      ...withDetails(driver, all),
      focus: context.message.id,
    };
  });

  // Resolution d un permalien Mattermost, qui designe un message par son
  // identifiant d origine et non par sa position dans l index.
  app.get("/api/permalink/:pid", (request, reply) => {
    const { pid } = z.object({ pid: z.string().min(1).max(64) }).parse(request.params);
    const message = getMessageByPid(driver, pid);
    if (message === undefined) {
      return reply.code(404).send({ error: "Ce message ne figure pas dans l archive." });
    }
    return { message };
  });

  app.get("/api/threads/:id", (request, reply) => {
    const { id } = idParam.parse(request.params);
    const thread = getThread(driver, id);
    if (thread.root === undefined && thread.replies.length === 0) {
      return reply.code(404).send({ error: "Fil inconnu." });
    }
    const all = thread.root === undefined ? thread.replies : [thread.root, ...thread.replies];
    // Une reponse dont la racine est absente porte le drapeau orphanRoot : elle
    // n apparait pas ici, elle se lit dans son canal en annoncant qu il lui
    // manque un contexte.
    return withDetails(driver, all);
  });

  app.get("/api/search", (request) => {
    const query = searchQuery.parse(request.query);
    const result = searchMessages(driver, query.q, {
      ...pageOptions(query),
      ...(query.tz === undefined ? {} : { timeZoneOffsetMinutes: query.tz }),
    });
    if (result.kind !== "ok") {
      return {
        status: result.kind,
        ...(result.kind === "introuvable" ? { names: result.names } : {}),
      };
    }
    return {
      status: "ok",
      ...withDetails(driver, result.page.items),
      nextCursor: result.page.nextCursor ?? null,
    };
  });

  app.get("/api/users", () => ({ users: listUsers(driver) }));

  registerFileRoutes(app, driver, archiveRoot);
  registerWebRoutes(app, options.webRoot);
  return app;
}

/**
 * Sert le frontend construit, s il a ete produit.
 *
 * Le routage se fait par fragment, jamais par chemin : une seule page suffit,
 * et rien n a besoin d etre reecrit cote serveur. C est aussi ce qui permettra
 * au meme dossier de fonctionner ouvert depuis le disque.
 */
function registerWebRoutes(app: FastifyInstance, webRoot: string | undefined): void {
  if (webRoot === undefined) return;
  const root = resolve(webRoot);
  app.register(fastifyStatic, {
    root,
    prefix: "/",
    decorateReply: false,
    index: ["index.html"],
    setHeaders: (reply, path) => {
      // L index change a chaque publication ; les fichiers construits portent
      // une empreinte dans leur nom et peuvent etre gardes longtemps.
      if (path.endsWith("index.html")) void reply.header("cache-control", "no-cache");
    },
  });
}

function sendArchiveFile(
  reply: FastifyReply,
  archiveRoot: string,
  storedPath: string,
  downloadName: string,
): FastifyReply {
  try {
    resolveArchivePath(archiveRoot, storedPath);
  } catch (error) {
    if (error instanceof UnsafeArchivePathError) {
      return reply.code(403).send({ error: "Chemin refuse." });
    }
    throw error;
  }
  void reply.header("content-disposition", contentDisposition(downloadName));
  // sendFile plutot que download : @fastify/static resout download depuis son
  // propre root et rend 404 quand la racine n est pas repassee explicitement.
  return reply.sendFile(storedPath, archiveRoot);
}

function registerFileRoutes(app: FastifyInstance, driver: SqlDriver, archiveRoot: string): void {
  app.get("/files/:fid", (request, reply) => {
    const { fid } = z.object({ fid: z.string().min(1).max(64) }).parse(request.params);
    const row = driver.get("SELECT name, path, skip_reason FROM file WHERE fid = ?", [fid]);
    if (row === undefined) return reply.code(404).send({ error: "Piece jointe inconnue." });
    const path = row.path;
    if (typeof path !== "string") {
      // La metadonnee existe sans le binaire : le dire vaut mieux que de faire
      // disparaitre une information qui existait.
      return reply.code(410).send({
        error: "Piece jointe non archivee.",
        reason: typeof row.skip_reason === "string" ? row.skip_reason : null,
      });
    }
    return sendArchiveFile(reply, archiveRoot, path, str(row, "name"));
  });

  app.get("/avatars/:uid", (request, reply) => {
    const { uid } = z.object({ uid: z.string().min(1).max(64) }).parse(request.params);
    const row = driver.get("SELECT avatar, username FROM user WHERE uid = ?", [uid]);
    const avatar = row?.avatar;
    if (typeof avatar !== "string") return reply.code(404).send({ error: "Avatar absent." });
    return sendArchiveFile(reply, archiveRoot, avatar, `${str(row ?? {}, "username")}.png`);
  });

  app.get("/emoji/:name", (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(128) }).parse(request.params);
    const row = driver.get("SELECT image FROM emoji WHERE name = ?", [name]);
    const image = row?.image;
    if (typeof image !== "string") return reply.code(404).send({ error: "Emoji absent." });
    return sendArchiveFile(reply, archiveRoot, image, `${name}.png`);
  });
}
