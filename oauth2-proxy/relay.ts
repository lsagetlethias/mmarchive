import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Readable } from "node:stream";

const DEFAULT_PORT = 8787;

/**
 * Longueur en deca de laquelle un cookie de session oauth2-proxy est forcement
 * incomplet. Une session portant une identite OIDC en fait plusieurs centaines a
 * plusieurs milliers ; c est le seul controle qui attrape une valeur tronquee a
 * la copie, panne qui se presente autrement comme un refus d authentification.
 */
const MIN_SESSION_COOKIE_LENGTH = 200;

/**
 * En-tetes propres au saut reseau courant, qui ne se reconduisent pas vers
 * l amont. accept-encoding en fait partie ici pour une raison distincte : fetch
 * negocie et decode lui-meme la compression, reconduire celui du client
 * decrirait un corps qui n existe plus.
 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

const SESSION_COOKIE = "_oauth2_proxy";
const CHUNKED_SESSION_COOKIE = /^_oauth2_proxy_\d+$/;

export interface RelayConfig {
  readonly upstream: string;
  readonly port: number;
  readonly bearer: string;
}

export class ConfigError extends Error {}

function readCookieHeader(env: NodeJS.ProcessEnv): string {
  const path = env.MMPROXY_COOKIE_FILE ?? "";
  let raw = env.MMPROXY_COOKIE ?? "";
  if (path !== "") {
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new ConfigError(`Lecture de MMPROXY_COOKIE_FILE impossible : ${String(cause)}`);
    }
  }
  // Un copier-coller depuis les outils de developpement traine souvent le nom de
  // l en-tete et des retours a la ligne. Les envoyer tels quels produirait un
  // cookie invalide dont le refus serait indistinguable d une session expiree.
  return raw
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, " ");
}

export function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const piece of header.split(";")) {
    const separator = piece.indexOf("=");
    if (separator <= 0) continue;
    jar.set(piece.slice(0, separator).trim(), piece.slice(separator + 1).trim());
  }
  return jar;
}

export function resolveConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const upstream = (env.MMPROXY_UPSTREAM ?? "").trim().replace(/\/+$/, "");
  if (upstream === "") {
    throw new ConfigError(
      "MMPROXY_UPSTREAM manquant. Attendu l URL de l instance, par exemple https://mattermost.example.org.",
    );
  }

  const rawPort = env.MMPROXY_PORT ?? "";
  const port = rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `MMPROXY_PORT invalide : "${rawPort}". Attendu un port entre 1 et 65535.`,
    );
  }

  return { upstream, port, bearer: env.MMPROXY_BEARER ?? "" };
}

export interface CookieInventory {
  readonly entries: readonly { readonly name: string; readonly length: number }[];
  readonly chunks: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Decrit la table de cookies sans jamais en divulguer une valeur : les noms et
 * les longueurs suffisent a distinguer une troncature d un mauvais cookie, et
 * c est exactement la confusion qui coute le plus de temps ici.
 */
export function inspectJar(jar: ReadonlyMap<string, string>): CookieInventory {
  const entries = [...jar.entries()].map(([name, value]) => ({ name, length: value.length }));
  const chunks = [...jar.keys()].filter((name) => CHUNKED_SESSION_COOKIE.test(name));
  const session = jar.get(SESSION_COOKIE);
  const warnings: string[] = [];

  if (session === undefined && chunks.length === 0) {
    warnings.push(
      `Aucun cookie de session : ni ${SESSION_COOKIE}, ni la forme decoupee ${SESSION_COOKIE}_0 et suivants.`,
    );
    if (jar.has(`${SESSION_COOKIE}_csrf`)) {
      warnings.push(
        `Seul ${SESSION_COOKIE}_csrf est present. Il ne vaut que le temps d une connexion en cours, ce n est pas une session etablie.`,
      );
    }
  } else if (
    session !== undefined &&
    chunks.length === 0 &&
    session.length < MIN_SESSION_COOKIE_LENGTH
  ) {
    warnings.push(
      `${SESSION_COOKIE} ne fait que ${String(session.length)} caracteres, donc vraisemblablement tronque a la copie. ` +
        "Recopier l en-tete depuis l onglet Network : la grille de l onglet Application coupe les valeurs longues.",
    );
  }

  return { entries, chunks, warnings };
}

export class CookieJar {
  private readonly cookies: Map<string, string>;

  constructor(header: string) {
    this.cookies = parseCookieHeader(header);
  }

  get size(): number {
    return this.cookies.size;
  }

  snapshot(): ReadonlyMap<string, string> {
    return this.cookies;
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /**
   * Un run d extraction dure plus longtemps que la session initiale. L amont la
   * prolonge par Set-Cookie au fil des reponses : sans cette absorption, le
   * relais continuerait a presenter la valeur d origine jusqu a son expiration.
   */
  absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const first = line.split(";", 1)[0] ?? "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      const value = first.slice(separator + 1).trim();
      if (value === "" || value === "deleted") {
        this.cookies.delete(name);
        console.warn(`[relais] l amont a revoque le cookie ${name}`);
        continue;
      }
      if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        console.warn(`[relais] session ${name} rafraichie par l amont`);
      }
    }
  }
}

/**
 * Une reponse sans x-version-id n a jamais atteint Mattermost : c est le portier
 * qui a repondu. Sans ce controle, son 401 remonte tel quel jusqu a l extracteur
 * et passe pour un jeton Mattermost expire, ce qui envoie chercher la panne au
 * mauvais endroit.
 */
export function looksIntercepted(status: number, headers: Headers): boolean {
  if (headers.get("x-version-id") !== null) return false;
  if (status === 401 || status === 403 || status === 302) return true;
  return (headers.get("content-type") ?? "").includes("text/html");
}

function forwardedRequestHeaders(
  request: IncomingMessage,
  jar: CookieJar,
  bearer: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.cookie = jar.header();
  if (bearer !== "") headers.authorization = `Bearer ${bearer}`;
  return headers;
}

function forwardedResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    // Le corps a ete decode par fetch : reconduire ces trois en-tetes decrirait
    // un encodage et une longueur qui ne correspondent plus a ce qui sort.
    if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding")
      return;
    // La session appartient au relais, pas au client local a qui elle ne servirait a rien.
    if (name === "set-cookie") return;
    out[name] = value;
  });
  return out;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

export function createRelay(config: RelayConfig, jar: CookieJar): ReturnType<typeof createServer> {
  let interceptionReported = false;

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async (): Promise<void> => {
      const target = `${config.upstream}${request.url ?? "/"}`;
      const body = await readBody(request);
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers: forwardedRequestHeaders(request, jar, config.bearer),
        // Sans cela, une 302 du portier vers le fournisseur d identite serait
        // suivie jusqu a une page de connexion renvoyee en 200, que l extracteur
        // prendrait pour une reponse legitime.
        redirect: "manual",
      };
      if (body !== undefined) init.body = new Uint8Array(body);

      let upstream: Response;
      try {
        upstream = await fetch(target, init);
      } catch (cause) {
        console.error(
          `[relais] echec reseau vers l amont sur ${request.url ?? "/"} : ${String(cause)}`,
        );
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "relais : amont injoignable" }));
        return;
      }

      jar.absorb(upstream.headers);

      if (!interceptionReported && looksIntercepted(upstream.status, upstream.headers)) {
        interceptionReported = true;
        console.error("");
        console.error(
          `[relais] INTERCEPTE par le portier sur ${request.url ?? "/"} (${String(upstream.status)}).`,
        );
        console.error("[relais] Mattermost n a pas ete atteint : aucun en-tete x-version-id.");
        console.error("[relais] La session est expiree ou incomplete, recopier l en-tete Cookie.");
        console.error("");
      }

      response.writeHead(upstream.status, forwardedResponseHeaders(upstream.headers));
      if (upstream.body === null) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    })();
  });
}

function describeAccount(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "reponse non JSON";
  }
  if (typeof parsed !== "object" || parsed === null) return "reponse inattendue";
  const record = parsed as Record<string, unknown>;
  const username = record.username;
  const id = record.id;
  if (typeof username !== "string" || typeof id !== "string") return "reponse sans compte";
  return `${username} (${id})`;
}

/**
 * Interroge l endpoint de verification d oauth2-proxy, dont c est la seule
 * fonction : dire si la session presentee est valide. Cela separe "mon cookie
 * franchit le portier" de "Mattermost accepte mon jeton", deux questions que le
 * 401 du portier confond en une seule.
 */
async function probeGatekeeper(config: RelayConfig, jar: CookieJar): Promise<boolean> {
  const response = await fetch(`${config.upstream}/oauth2/auth`, {
    headers: { accept: "application/json", cookie: jar.header() },
    redirect: "manual",
  });
  jar.absorb(response.headers);

  console.warn("--- etage 1 : le portier ---");
  console.warn(`GET /oauth2/auth  : ${String(response.status)}`);
  if (response.status !== 200 && response.status !== 202) {
    console.warn("session           : REFUSEE par le portier");
    return false;
  }
  const identity =
    response.headers.get("x-auth-request-email") ?? response.headers.get("x-auth-request-user");
  console.warn(`session           : VALIDE${identity === null ? "" : ` (${identity})`}`);
  return true;
}

async function probeUpstream(config: RelayConfig, jar: CookieJar): Promise<boolean> {
  const headers: Record<string, string> = { accept: "application/json", cookie: jar.header() };
  if (config.bearer !== "") headers.authorization = `Bearer ${config.bearer}`;

  const response = await fetch(`${config.upstream}/api/v4/users/me`, {
    headers,
    redirect: "manual",
  });
  jar.absorb(response.headers);
  const version = response.headers.get("x-version-id");
  const payload = await response.text();

  console.warn("--- etage 2 : Mattermost ---");
  console.warn(`GET /users/me     : ${String(response.status)}`);
  console.warn(`x-version-id      : ${version ?? "ABSENT, le portier a repondu"}`);

  if (version === null) {
    console.warn("resultat          : la requete n a pas atteint Mattermost");
    console.warn(`corps (debut)     : ${payload.slice(0, 120).replace(/\s+/g, " ")}`);
    return false;
  }
  if (!response.ok) {
    console.warn("resultat          : portier franchi, Mattermost refuse le jeton");
    console.warn(`corps (debut)     : ${payload.slice(0, 200)}`);
    return false;
  }
  console.warn(`compte            : ${describeAccount(payload)}`);
  console.warn("resultat          : OK, la traversee fonctionne");
  return true;
}

function reportInventory(jar: CookieJar): void {
  const inventory = inspectJar(jar.snapshot());
  console.warn("--- cookies charges ---");
  for (const entry of inventory.entries) {
    console.warn(`${entry.name.padEnd(24)} ${String(entry.length).padStart(5)} caracteres`);
  }
  if (inventory.chunks.length > 0) {
    console.warn(
      `session decoupee en ${String(inventory.chunks.length)} morceaux : ${inventory.chunks.join(", ")}`,
    );
  }
  for (const warning of inventory.warnings) {
    console.warn("");
    console.warn(`ATTENTION : ${warning}`);
  }
}

async function main(): Promise<void> {
  let config: RelayConfig;
  let jar: CookieJar;
  try {
    config = resolveConfig(process.env);
    jar = new CookieJar(readCookieHeader(process.env));
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  if (jar.size === 0) {
    console.error("MMPROXY_COOKIE (ou MMPROXY_COOKIE_FILE) manquant ou vide.");
    process.exitCode = 2;
    return;
  }

  reportInventory(jar);
  console.warn("");
  const gatekeeperOk = await probeGatekeeper(config, jar);
  console.warn("");
  const upstreamOk = await probeUpstream(config, jar);
  console.warn("");

  if (!gatekeeperOk) {
    console.error(
      "Le cookie ne franchit pas le portier, inutile de chercher du cote de Mattermost.",
    );
    console.error(
      "Recopier l en-tete Cookie ENTIER depuis l onglet Network des outils de developpement.",
    );
  } else if (!upstreamOk) {
    console.error(
      "Le portier est franchi, le cookie est bon. Le probleme restant est le jeton Mattermost.",
    );
  }

  createRelay(config, jar).listen(config.port, "127.0.0.1", () => {
    console.warn(
      `[relais] en ecoute sur http://127.0.0.1:${String(config.port)} vers ${config.upstream}`,
    );
  });
}

await main();
