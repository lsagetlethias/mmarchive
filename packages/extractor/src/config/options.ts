import { createHash } from "node:crypto";

export interface ConnectionOptions {
  readonly url: string;
  readonly token: string;
}

export interface RunOptions {
  readonly connection: ConnectionOptions;
  readonly file: string | undefined;
  readonly out: string;
  readonly yes: boolean;
  readonly joinTeams: boolean;
  readonly leaveAfter: boolean;
  readonly since: number | undefined;
  readonly resume: boolean;
  readonly skipFiles: boolean;
  readonly maxFileSizeBytes: number;
  readonly includeEmails: boolean;
  readonly concurrency: number;
  readonly rateLimit: number;
  readonly postsPageSize: number;
}

export class OptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionsError";
  }
}

/** Valeurs brutes telles que commander les fournit, plus l environnement. */
export interface RawOptions {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly file?: string | undefined;
  readonly out?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly joinTeams?: boolean | undefined;
  readonly leaveAfter?: boolean | undefined;
  readonly since?: string | undefined;
  readonly resume?: boolean | undefined;
  readonly skipFiles?: boolean | undefined;
  readonly maxFileSize?: string | undefined;
  readonly includeEmails?: boolean | undefined;
  readonly concurrency?: string | undefined;
  readonly rateLimit?: string | undefined;
  readonly postsPageSize?: string | undefined;
}

const DEFAULT_OUT = "./archive";
const DEFAULT_MAX_FILE_SIZE_MB = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RATE_LIMIT = 8;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const MAX_RATE_LIMIT = 100;
const RATE_LIMIT_WARN_THRESHOLD = 10;
const BYTES_PER_MB = 1024 * 1024;
const MS_PER_MINUTE = 60_000;
const API_SUFFIX = "/api/v4";

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UTC_OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/;

export interface NormalizedUrl {
  readonly url: string;
  /** Message a afficher quand l URL fournie a du etre corrigee. */
  readonly notice: string | undefined;
}

/**
 * Normalise l URL d instance sans effet de bord : les corrections eventuelles
 * sont rendues au travers de `notice` plutot qu ecrites sur un flux, la couche
 * CLI restant seule responsable de l affichage.
 */
export function normalizeInstanceUrl(rawUrl: string): NormalizedUrl {
  const value = rawUrl.trim();
  if (value === "") {
    throw new OptionsError(
      "URL de l instance vide. Passez --url ou renseignez la variable d environnement MM_URL.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OptionsError(
      `URL d instance invalide : "${value}". Attendu une URL absolue, par exemple https://mattermost.example.org.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OptionsError(
      `Schema "${parsed.protocol.replace(":", "")}" non supporte pour l URL d instance : http ou https attendu.`,
    );
  }

  const notices: string[] = [];
  // Les identifiants embarques sont un secret : on les retire avant que l URL
  // n atterrisse dans un manifeste, un fichier d etat ou un message d erreur.
  if (parsed.username !== "" || parsed.password !== "") {
    parsed.username = "";
    parsed.password = "";
    notices.push(
      "Les identifiants embarques dans l URL ont ete retires : mmarchive s authentifie par token.",
    );
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  const hadApiSuffix = path.toLowerCase().endsWith(API_SUFFIX);
  if (hadApiSuffix) {
    path = path.slice(0, path.length - API_SUFFIX.length);
  }

  const url = `${parsed.protocol}//${parsed.host}${path}`;
  if (hadApiSuffix) {
    notices.push(
      `Le suffixe "${API_SUFFIX}" a ete retire de l URL d instance : mmarchive l ajoute lui-meme a chaque appel. URL retenue : ${url}`,
    );
  }

  return { url, notice: notices.length === 0 ? undefined : notices.join(" ") };
}

export function resolveConnection(
  raw: Pick<RawOptions, "url" | "token">,
  env: Record<string, string | undefined>,
): ConnectionOptions {
  const rawUrl = firstNonEmpty(raw.url, env.MM_URL);
  if (rawUrl === undefined) {
    throw new OptionsError(
      "URL de l instance manquante. Passez --url <url> ou renseignez la variable d environnement MM_URL.",
    );
  }

  const token = firstNonEmpty(raw.token, env.MM_TOKEN);
  if (token === undefined) {
    throw new OptionsError(
      "Token manquant. Passez --token <token> ou renseignez la variable d environnement MM_TOKEN.",
    );
  }

  return { url: normalizeInstanceUrl(rawUrl).url, token };
}

export function parseRunOptions(
  raw: RawOptions,
  env: Record<string, string | undefined>,
): RunOptions {
  return {
    connection: resolveConnection(raw, env),
    file: firstNonEmpty(raw.file),
    out: firstNonEmpty(raw.out) ?? DEFAULT_OUT,
    yes: raw.yes ?? false,
    joinTeams: raw.joinTeams ?? false,
    leaveAfter: raw.leaveAfter ?? false,
    since: parseSince(raw.since, Date.now()),
    resume: raw.resume ?? false,
    skipFiles: raw.skipFiles ?? false,
    maxFileSizeBytes: parseMaxFileSize(raw.maxFileSize),
    includeEmails: raw.includeEmails ?? false,
    concurrency: parseConcurrency(raw.concurrency),
    rateLimit: parseRateLimit(raw.rateLimit),
    postsPageSize: parsePostsPageSize(raw.postsPageSize),
  };
}

/** Valeur par defaut de la taille de page des posts. */
export const DEFAULT_POSTS_PAGE_SIZE = 200;

/**
 * Taille de page de GET /channels/{id}/posts.
 *
 * La spec ne documente AUCUN maximum pour ce parametre, pourtant l endpoint le
 * plus sollicite de l extraction. 200 est la valeur historique et sure ; un
 * serveur qui en accepte davantage divise d autant le nombre de requetes, ce que
 * la sous-commande doctor permet de mesurer avant de lancer un long run.
 */
function parsePostsPageSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_POSTS_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new OptionsError(
      `--posts-page-size "${raw}" invalide : attendu un entier entre 1 et 1000.`,
    );
  }
  return value;
}

/**
 * Avertissement au dela du debit par defaut d une instance Mattermost
 * (RateLimitSettings.PerSec vaut 10) : au-dessus, le serveur repond 429 et le
 * run ralentit au lieu d accelerer.
 */
export function rateLimitNotice(rateLimit: number): string | undefined {
  if (rateLimit <= RATE_LIMIT_WARN_THRESHOLD) {
    return undefined;
  }
  return `--rate-limit ${String(rateLimit)} depasse le defaut serveur Mattermost de ${String(RATE_LIMIT_WARN_THRESHOLD)} requetes par seconde : attendez-vous a des reponses 429 et a un run plus lent, pas plus rapide.`;
}

/**
 * Empreinte stable des options qui changent la FORME de l archive. Deux runs avec
 * la meme empreinte produisent des archives fusionnables.
 */
export function optionsFingerprint(options: RunOptions): string {
  const shape: readonly (readonly [string, boolean | number | null])[] = [
    ["include_emails", options.includeEmails],
    // Sans pieces jointes, la borne de taille n ecrit ni ne retire rien : la
    // retenir distinguerait deux runs --skip-files aux archives identiques et
    // ferait refuser une reprise legitime.
    ["max_file_size_bytes", options.skipFiles ? null : options.maxFileSizeBytes],
    ["since", options.since ?? null],
    ["skip_files", options.skipFiles],
  ];

  const canonical = [...shape]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("&");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function firstNonEmpty(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

function parseNumericFlag(rawValue: string, flag: string): number {
  const value = rawValue.trim();
  if (!DECIMAL_PATTERN.test(value)) {
    throw new OptionsError(`${flag} attend un nombre, recu "${rawValue}".`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new OptionsError(`${flag} attend un nombre fini, recu "${rawValue}".`);
  }
  return parsed;
}

interface IsoParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly offsetMinutes: number;
}

function parseSince(rawValue: string | undefined, now: number): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const value = rawValue.trim();
  if (value === "") {
    return undefined;
  }

  const parts = matchIsoParts(value);
  if (parts === undefined) {
    throw new OptionsError(
      `--since attend une date ISO 8601 comme "2024-01-15" ou "2024-01-15T10:00:00Z", recu "${rawValue}".`,
    );
  }

  const epochMs = isoPartsToEpochMs(parts);
  if (epochMs === undefined) {
    throw new OptionsError(`--since : "${rawValue}" n est pas une date reelle du calendrier.`);
  }
  if (epochMs > now) {
    throw new OptionsError(
      `--since ne peut pas etre dans le futur : "${rawValue}" est posterieur a l instant present, aucun message ne serait extrait.`,
    );
  }
  return epochMs;
}

function matchIsoParts(value: string): IsoParts | undefined {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const offsetMinutes = parseOffsetMinutes(offset);
  if (offsetMinutes === undefined) {
    return undefined;
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    millisecond: fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")),
    offsetMinutes,
  };
}

/**
 * Un horodatage sans decalage explicite vaut UTC, jamais le fuseau de la
 * machine : `Date.parse("2024-01-15T10:00:00")` rend un instant different selon
 * le poste, l empreinte d options change avec lui et une reprise legitime finit
 * refusee. La forme date seule vaut deja minuit UTC, les deux doivent coincider.
 */
function parseOffsetMinutes(offset: string | undefined): number | undefined {
  if (offset === undefined || offset === "Z") {
    return 0;
  }
  const match = UTC_OFFSET_PATTERN.exec(offset);
  if (match === null) {
    return undefined;
  }
  const [, sign, rawHour, rawMinute] = match;
  if (sign === undefined || rawHour === undefined || rawMinute === undefined) {
    return undefined;
  }
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return (sign === "-" ? -1 : 1) * (hour * 60 + minute);
}

function isoPartsToEpochMs(parts: IsoParts): number | undefined {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    return undefined;
  }
  if (parts.minute > 59 || parts.second > 59) {
    return undefined;
  }
  // ISO 8601 admet 24:00 comme fin de journee, mais uniquement pile.
  const endOfDay =
    parts.hour === 24 && parts.minute === 0 && parts.second === 0 && parts.millisecond === 0;
  if (parts.hour > 23 && !endOfDay) {
    return undefined;
  }

  const probe = new Date(0);
  // setUTCFullYear plutot que Date.UTC : ce dernier remappe les annees a deux
  // chiffres sur 1900+, ce qui accepterait "0050-01-01" comme 1950.
  probe.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  probe.setUTCHours(0, 0, 0, 0);
  // Un quantieme hors bornes deborde silencieusement : "2024-02-31" deviendrait
  // le 2 mars. L aller-retour est la seule verification calendaire fiable.
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() !== parts.month - 1 ||
    probe.getUTCDate() !== parts.day
  ) {
    return undefined;
  }

  probe.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  const epochMs = probe.getTime() - parts.offsetMinutes * MS_PER_MINUTE;
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function parseMaxFileSize(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_MAX_FILE_SIZE_MB * BYTES_PER_MB;
  }
  const megabytes = parseNumericFlag(rawValue, "--max-file-size");
  if (megabytes < 0) {
    throw new OptionsError(
      `--max-file-size attend une taille en Mo strictement positive, recu "${rawValue}".`,
    );
  }
  // Le controle porte sur les octets, pas sur les Mo : une valeur sous le demi
  // octet s arrondit a 0 et rendrait toute piece jointe "trop volumineuse",
  // exactement ce que le refus de 0 cherche a eviter.
  const bytes = Math.round(megabytes * BYTES_PER_MB);
  if (bytes < 1) {
    throw new OptionsError(
      `--max-file-size "${rawValue}" ignorerait toutes les pieces jointes. Utilisez --skip-files, c est l intention reelle.`,
    );
  }
  if (!Number.isSafeInteger(bytes)) {
    throw new OptionsError(
      `--max-file-size "${rawValue}" depasse la taille qu un compteur d octets represente exactement (${String(Number.MAX_SAFE_INTEGER)} octets).`,
    );
  }
  return bytes;
}

function parseConcurrency(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_CONCURRENCY;
  }
  const concurrency = parseNumericFlag(rawValue, "--concurrency");
  if (!Number.isInteger(concurrency)) {
    throw new OptionsError(`--concurrency attend un entier, recu "${rawValue}".`);
  }
  if (concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
    throw new OptionsError(
      `--concurrency doit etre compris entre ${String(MIN_CONCURRENCY)} et ${String(MAX_CONCURRENCY)}, recu ${String(concurrency)}.`,
    );
  }
  return concurrency;
}

function parseRateLimit(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_RATE_LIMIT;
  }
  const rateLimit = parseNumericFlag(rawValue, "--rate-limit");
  if (rateLimit <= 0) {
    throw new OptionsError(
      `--rate-limit doit etre strictement positif, recu ${String(rateLimit)} requetes par seconde.`,
    );
  }
  if (rateLimit > MAX_RATE_LIMIT) {
    throw new OptionsError(
      `--rate-limit ne peut pas depasser ${String(MAX_RATE_LIMIT)} requetes par seconde, recu ${String(rateLimit)}.`,
    );
  }
  return rateLimit;
}
