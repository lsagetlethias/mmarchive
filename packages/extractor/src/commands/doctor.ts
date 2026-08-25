import { categorizeChannel, type SelectionChannel, type SelectionFile } from "@mmarchive/shared";
import { resolveConnection, type RawOptions } from "../config/options.js";
import { createContext } from "../context.js";
import { readSelectionFile } from "../inventory/yaml-file.js";
import { MM } from "../mattermost/endpoints.js";
import { mmPostListSchema } from "../mattermost/types.js";
import { Logger } from "../ui/logger.js";
import { formatCount, formatDuration } from "../ui/run-reporter.js";

/** Tailles de page sondees, par ordre croissant. */
const PROBE_PAGE_SIZES = [200, 500, 1000] as const;

export interface RunEstimateInput {
  readonly channels: number;
  readonly messages: number;
  /** Part des messages portant une piece jointe, entre 0 et 1. */
  readonly attachmentRatio: number;
  readonly users: number;
  readonly emojis: number;
  readonly postsPageSize: number;
  readonly rateLimit: number;
}

export interface RunEstimate {
  readonly postPages: number;
  readonly attachments: number;
  readonly totalRequests: number;
  readonly durationMs: number;
}

/**
 * Estimation du cout d un run. Pure et testable : c est elle qui justifie les
 * recommandations, elle doit pouvoir etre verifiee sans serveur.
 */
export function estimateRun(input: RunEstimateInput): RunEstimate {
  const postPages = Math.ceil(input.messages / Math.max(input.postsPageSize, 1));
  const attachments = Math.round(input.messages * input.attachmentRatio);
  // Une requete de messages epingles par canal, un lot d utilisateurs pour 100,
  // un avatar par utilisateur, une image par emoji plus son listing.
  const totalRequests =
    postPages +
    input.channels +
    Math.ceil(input.users / 100) +
    input.users +
    input.emojis +
    1 +
    attachments;
  return {
    postPages,
    attachments,
    totalRequests,
    durationMs: (totalRequests / Math.max(input.rateLimit, 0.1)) * 1000,
  };
}

export interface Recommendation {
  readonly rateLimit: number;
  readonly concurrency: number;
  /** Debit theorique atteignable, requetes par seconde. */
  readonly achievableRate: number;
}

/** Debit vise quand le serveur n annonce aucune limite. Prudent volontairement. */
const UNTHROTTLED_TARGET_RATE = 30;

/**
 * Traduit une latence mesuree en reglages concrets.
 *
 * Une requete est dominee par la latence, pas par le debit : a 90 ms, une seule
 * requete en vol plafonne a 11 par seconde. Le nombre de requetes simultanees
 * necessaires pour atteindre un debit vise est donc debit x latence, et c est ce
 * que --concurrency controle indirectement.
 */
export function recommendSettings(input: {
  latencyMs: number;
  serverLimit: number | undefined;
}): Recommendation {
  const latencySeconds = Math.max(input.latencyMs, 1) / 1000;
  const target =
    input.serverLimit === undefined
      ? UNTHROTTLED_TARGET_RATE
      : Math.max(1, Math.floor(input.serverLimit * 0.8));
  // Marge de 50 % : les latences varient, et une requete lente ne doit pas
  // laisser le lien inutilise.
  const concurrency = Math.min(32, Math.max(1, Math.ceil(target * latencySeconds * 1.5)));
  return {
    rateLimit: target,
    concurrency,
    achievableRate: Math.round(concurrency / latencySeconds),
  };
}

export function medianLatency(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function biggestReadableChannel(file: SelectionFile): SelectionChannel | undefined {
  let best: SelectionChannel | undefined;
  for (const team of file.teams) {
    for (const channel of team.channels) {
      const category = categorizeChannel(channel);
      if (category === "join_required" || category === "archived_unreadable") continue;
      if (best === undefined || channel.message_count > best.message_count) best = channel;
    }
  }
  return best;
}

export interface DoctorCommandOptions extends RawOptions {
  readonly file?: string | undefined;
}

/**
 * Mesure sur l instance ce que la specification ne documente pas, pour calibrer
 * un long run au lieu de le deviner : debit reellement autorise, taille de page
 * acceptee pour les messages, latence.
 *
 * N emet que des lectures.
 */
export async function doctorCommand(
  raw: DoctorCommandOptions,
  env: Record<string, string | undefined>,
  logger = new Logger(),
): Promise<void> {
  const connection = resolveConnection(raw, env);
  const { api, client } = createContext(connection, { rateLimit: 8, logger });

  logger.section("Diagnostic de l instance");
  logger.info(`Instance : ${connection.url}`);

  const account = await api.getMe();
  const version = await api.detectServerVersion();
  logger.info(`Compte : ${account.username}`);
  logger.info(`Version du serveur : ${version}`);

  const file = raw.file === undefined ? undefined : await readSelectionFile(raw.file);
  const target = file === undefined ? undefined : biggestReadableChannel(file);

  logger.section("Debit autorise");
  const snapshot = client.rateLimitSnapshot;
  if (!snapshot.observed) {
    logger.success(
      "Le serveur n a renvoye aucun en-tete X-Ratelimit-*. Mattermost ne les emet que si " +
        "RateLimitSettings.Enable est actif : cette instance n applique probablement aucune " +
        "limite par utilisateur.",
    );
    logger.info(
      "Un debit plus eleve est donc envisageable. Montez --rate-limit par paliers et " +
        "surveillez les 429 : le client respecte les pauses demandees par le serveur.",
    );
  } else {
    logger.info(`X-Ratelimit-Limit : ${String(snapshot.limit ?? "absent")}`);
    logger.info(`X-Ratelimit-Remaining : ${String(snapshot.remaining ?? "absent")}`);
    if (snapshot.limit !== undefined) {
      const advised = Math.max(1, Math.floor(snapshot.limit * 0.8));
      logger.success(`Debit conseille : --rate-limit ${String(advised)} (80 % de la limite).`);
    }
  }

  logger.section("Taille de page des messages");
  let bestPageSize = 200;
  const latencies: number[] = [];
  if (target === undefined) {
    logger.warn(
      "Aucun canal lisible fourni : passez --file channels.yaml pour mesurer la taille de page.",
    );
  } else if (target.message_count < 1200) {
    logger.warn(
      `Le plus gros canal lisible ne contient que ${formatCount(target.message_count)} messages : ` +
        "trop petit pour distinguer un plafond serveur d une fin d historique.",
    );
  } else {
    const rows: string[][] = [];
    for (const size of PROBE_PAGE_SIZES) {
      const started = Date.now();
      const list = await client.json(
        MM.getChannelPosts(target.id, { perPage: size }),
        mmPostListSchema,
      );
      const elapsed = Date.now() - started;
      latencies.push(elapsed);
      const received = list.order.length;
      rows.push([String(size), String(received), `${String(elapsed)} ms`]);
      if (received >= size) bestPageSize = size;
    }
    logger.table(["per_page demande", "messages recus", "latence"], rows);
    if (bestPageSize > 200) {
      logger.success(
        `Le serveur accepte --posts-page-size ${String(bestPageSize)}, ` +
          `soit ${String(Math.round(bestPageSize / 200))} fois moins de requetes de pages.`,
      );
    } else {
      logger.info("Le serveur plafonne a 200 messages par page. Gardez la valeur par defaut.");
    }
  }

  if (file === undefined) return;

  logger.section("Estimation du run");
  let channels = 0;
  let messages = 0;
  for (const team of file.teams) {
    for (const channel of team.channels) {
      if (!channel.selected) continue;
      if (categorizeChannel(channel) === "archived_unreadable") continue;
      channels += 1;
      messages += channel.message_count;
    }
  }

  // La premiere requete porte l etablissement de la connexion TLS : elle n est
  // pas representative du regime permanent.
  const steady = latencies.length > 1 ? latencies.slice(1) : latencies;
  const latencyMs = medianLatency(steady);
  const advice = recommendSettings({ latencyMs, serverLimit: snapshot.limit });
  const rateLimit = advice.rateLimit;
  const before = estimateRun({
    channels,
    messages,
    attachmentRatio: 0.05,
    users: 2000,
    emojis: 762,
    postsPageSize: 200,
    rateLimit: 8,
  });
  const after = estimateRun({
    channels,
    messages,
    attachmentRatio: 0.05,
    users: 2000,
    emojis: 762,
    postsPageSize: bestPageSize,
    rateLimit,
  });

  logger.section("Reglages conseilles");
  if (latencyMs > 0) {
    logger.info(`Latence mediane mesuree : ${String(latencyMs)} ms.`);
    logger.info(
      `Une seule requete en vol plafonnerait donc a ${String(Math.round(1000 / latencyMs))} req/s.`,
    );
  }
  logger.success(
    `--rate-limit ${String(advice.rateLimit)} --concurrency ${String(advice.concurrency)}`,
  );
  if (!snapshot.observed) {
    logger.warn(
      "L absence d en-tetes ne prouve pas l absence de limite : un proxy en amont peut en " +
        "appliquer une sans les emettre. Montez par paliers et surveillez les 429.",
    );
  }

  logger.table(
    ["", "Par defaut", "Calibre"],
    [
      ["Taille de page", "200", String(bestPageSize)],
      ["Debit", "8 req/s", `${String(rateLimit)} req/s`],
      ["Canaux en parallele", "4", String(advice.concurrency)],
      ["Pages de messages", formatCount(before.postPages), formatCount(after.postPages)],
      ["Requetes totales", formatCount(before.totalRequests), formatCount(after.totalRequests)],
      ["Duree estimee", formatDuration(before.durationMs), formatDuration(after.durationMs)],
    ],
  );
  logger.info(
    `${formatCount(channels)} canaux, ${formatCount(messages)} messages. ` +
      "Le ratio de pieces jointes retenu est de 5 %, mesure sur une extraction reelle : " +
      "il domine l estimation et varie beaucoup d une instance a l autre.",
  );
}
