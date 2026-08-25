import type { ZodType, ZodTypeDef } from "zod";
import {
  ForbiddenMutationError,
  MattermostAuthError,
  MattermostForbiddenError,
  MattermostHttpError,
  MattermostNotFoundError,
  MattermostRateLimitError,
  MattermostResponseError,
  NetworkError,
  type MattermostAppError,
} from "./errors.js";
import type { EndpointCall } from "./endpoints.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";

export interface MattermostClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Requetes par seconde. Le defaut serveur Mattermost est 10. */
  readonly rateLimit: number;
  readonly maxRetries?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly onRetry?: ((info: RetryInfo) => void) | undefined;
}

export interface RetryInfo {
  readonly template: string;
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: "rate_limit" | "server_error" | "network";
}

export interface BinaryResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly size: number;
}

/** Executeur brut, capable de muter. Confie uniquement a MutationGate. */
export type RawExecutor = (call: EndpointCall) => Promise<unknown>;

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseAppError(bodyText: string): MattermostAppError | undefined {
  // Le corps d une 429 peut etre du texte brut ("limit exceeded") alors que la
  // spec annonce du JSON. On ne fait donc jamais confiance au content-type.
  if (!bodyText.trim().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deduit le temps d attente d une 429.
 *
 * Retry-After n est PAS documente dans la spec Mattermost : seuls
 * X-Ratelimit-Limit, X-Ratelimit-Remaining et X-Ratelimit-Reset le sont. On
 * lit tout de meme Retry-After en premier parce que les proxys en amont
 * (nginx, Cloudflare) en ajoutent souvent, puis on retombe sur Reset, puis sur
 * un backoff.
 */
/**
 * Plafond de toute attente deduite d un en-tete serveur.
 *
 * Deux raisons de plafonner, pas une seule. D abord une attente de plusieurs
 * heures sur une extraction interactive est indistinguable d un blocage.
 * Ensuite et surtout, Node stocke les delais de timer sur un entier signe
 * 32 bits : au dela de 2 147 483 647 ms, setTimeout se declenche apres 1 ms au
 * lieu d attendre. Une valeur aberrante (un proxy qui renvoie Retry-After en
 * millisecondes au lieu de secondes) transformerait donc la temporisation en
 * boucle chaude qui martele le serveur deja en surcharge.
 */
const MAX_RATE_LIMIT_WAIT_MS = 300_000;

/**
 * Extrait la version du serveur du header X-Version-Id.
 *
 * Ce header n est pas contractuel : la spec ne le declare nulle part, et aucun
 * endpoint ne renvoie la version dans son corps. Sa valeur observee agrege
 * plusieurs champs separes par des points, par exemple
 * "10.12.4.19423977602.e5239d09275ad2a214c812215220c92b.false".
 * Seuls les trois premiers segments numeriques forment la version publiee ;
 * le reste est un numero de build, un hash et un drapeau entreprise, qui n ont
 * aucun sens pour un lecteur d archive.
 */
export function parseServerVersion(headerValue: string): string | undefined {
  const segments = headerValue.split(".");
  const semantic: string[] = [];
  for (const segment of segments) {
    if (semantic.length === 3 || !/^\d+$/.test(segment)) break;
    semantic.push(segment);
  }
  if (semantic.length === 3) return semantic.join(".");
  return headerValue.length > 0 ? headerValue : undefined;
}

export function rateLimitDelayMs(headers: Headers, attempt: number, nowSeconds: number): number {
  const capped = (ms: number): number => Math.min(Math.ceil(ms), MAX_RATE_LIMIT_WAIT_MS);

  // Retry-After n est pas documente dans la spec Mattermost, mais les proxys en
  // amont en ajoutent souvent. On le lit en premier, sans lui faire confiance.
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return capped(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const delta = date - nowSeconds * 1000;
      if (delta > 0) return capped(delta);
    }
  }

  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const resetValue = Number(reset);
    if (Number.isFinite(resetValue) && resetValue > 0) {
      // La spec decrit ce header comme "secondes epoch UTC restantes avant
      // reinitialisation", formulation ambigue : certaines versions renvoient
      // un instant epoch, d autres une duree. On distingue par l ordre de
      // grandeur, un instant epoch etant tres superieur a une duree plausible.
      const asDuration = resetValue < 1_000_000 ? resetValue : resetValue - nowSeconds;
      if (asDuration > 0) return capped(asDuration * 1000);
    }
  }

  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function backoffDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(500 * 2 ** attempt, 20_000);
  // Jitter complet : sur des centaines de requetes concurrentes, un backoff
  // deterministe les ferait toutes repartir en meme temps.
  return Math.round(base * (0.5 + random() * 0.5));
}

export class MattermostClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;
  private detectedServerVersion: string | undefined;

  constructor(options: MattermostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.limiter = new TokenBucketRateLimiter({ requestsPerSecond: options.rateLimit });
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRetry = options.onRetry;
  }

  /** Version du serveur, lue dans le header X-Version-Id. */
  get serverVersion(): string | undefined {
    return this.detectedServerVersion;
  }

  /**
   * Execute un appel en lecture et valide la reponse.
   * Refuse tout EndpointCall marque comme mutant : c est ce refus qui garantit
   * qu aucun canal ne peut etre rejoint par un chemin detourne.
   */
  async json<T>(call: EndpointCall, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    this.assertReadOnly(call);
    const raw = await this.execute(call);
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new MattermostResponseError(
        `Reponse inattendue de ${call.method} ${call.template} : ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join(", ")}`,
      );
    }
    return result.data;
  }

  /** Execute un appel en lecture renvoyant un flux binaire. */
  async binary(call: EndpointCall): Promise<BinaryResponse> {
    this.assertReadOnly(call);
    const response = await this.send(call);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: buffer,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      size: buffer.byteLength,
    };
  }

  /**
   * Fabrique l executeur brut confie a MutationGate. C est le SEUL chemin vers
   * une requete mutante, et il n est jamais expose publiquement.
   */
  createRawExecutor(): RawExecutor {
    return (call: EndpointCall) => this.execute(call, { retryOnFailure: false });
  }

  private assertReadOnly(call: EndpointCall): void {
    if (call.mutates) {
      throw new ForbiddenMutationError(call.template, call.method);
    }
  }

  private async execute(
    call: EndpointCall,
    options: { retryOnFailure?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.send(call, options);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MattermostResponseError(
        `Reponse non JSON de ${call.method} ${call.template} : ${text.slice(0, 120)}`,
      );
    }
  }

  private async send(
    call: EndpointCall,
    options: { retryOnFailure?: boolean } = {},
  ): Promise<Response> {
    // Une mutation n est jamais rejouee automatiquement : un join re-emis apres
    // un timeout pourrait publier un second message systeme dans le canal.
    const retryOnFailure = options.retryOnFailure ?? !call.mutates;
    const url = this.buildUrl(call);

    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();

      let response: Response;
      try {
        response = await this.fetchOnce(url, call);
      } catch (error) {
        if (!retryOnFailure || attempt >= this.maxRetries) {
          throw new NetworkError(
            `Echec reseau sur ${call.method} ${call.template} apres ${String(attempt + 1)} tentative(s).`,
            error,
          );
        }
        const delay = backoffDelayMs(attempt, Math.random);
        this.onRetry?.({ template: call.template, attempt, delayMs: delay, reason: "network" });
        await this.sleep(delay);
        attempt += 1;
        continue;
      }

      const version = response.headers.get("x-version-id");
      if (version !== null && version.length > 0) {
        this.detectedServerVersion = parseServerVersion(version);
      }

      if (response.ok) return response;

      const bodyText = await response.text();
      const appError = parseAppError(bodyText);
      const failure = {
        status: response.status,
        method: call.method,
        template: call.template,
        appError,
        bodyText,
      };

      if (response.status === 429) {
        const delay = rateLimitDelayMs(response.headers, attempt, Date.now() / 1000);
        if (!retryOnFailure || attempt >= this.maxRetries) {
          throw new MattermostRateLimitError(failure, delay);
        }
        // Le serveur fait autorite : on suspend TOUS les appelants, pas seulement
        // celui-ci, sinon les requetes concurrentes continuent de se faire jeter.
        this.limiter.pauseFor(delay);
        this.onRetry?.({ template: call.template, attempt, delayMs: delay, reason: "rate_limit" });
        await this.sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.status >= 500) {
        if (!retryOnFailure || attempt >= this.maxRetries) {
          throw new MattermostHttpError(failure);
        }
        const delay = backoffDelayMs(attempt, Math.random);
        this.onRetry?.({
          template: call.template,
          attempt,
          delayMs: delay,
          reason: "server_error",
        });
        await this.sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.status === 401) throw new MattermostAuthError(failure);
      if (response.status === 403) throw new MattermostForbiddenError(failure);
      if (response.status === 404) throw new MattermostNotFoundError(failure);
      throw new MattermostHttpError(failure);
    }
  }

  private buildUrl(call: EndpointCall): string {
    const url = new URL(`${this.baseUrl}/api/v4${call.path}`);
    if (call.query) {
      for (const [key, value] of Object.entries(call.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async fetchOnce(url: string, call: EndpointCall): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.token}`,
        accept: call.binary === true ? "*/*" : "application/json",
      };
      const init: RequestInit = { method: call.method, headers, signal: controller.signal };
      if (call.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(call.body);
      }
      return await this.fetchImpl(url, init);
    } finally {
      clearTimeout(timer);
    }
  }
}
