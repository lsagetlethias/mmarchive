import { z } from "zod";
import {
  archiveWarningSchema,
  joinedChannelRecordSchema,
  joinedTeamRecordSchema,
} from "./archive/manifest.js";

/**
 * Etat de reprise. Ecrit au fil de l eau, jamais en fin de run : un kill au
 * milieu d un canal de 200 000 messages doit laisser un etat exploitable, et
 * surtout la trace des canaux rejoints pour pouvoir les quitter ensuite.
 */

export const STATE_VERSION = 1;

export const channelProgressSchema = z.object({
  status: z.enum(["pending", "in_progress", "complete", "failed", "skipped"]),
  /**
   * Curseur de pagination : id du post le plus ancien deja ecrit. La page
   * suivante est demandee avec before=<ce id>. null tant que rien n a ete lu.
   */
  oldest_post_id: z.string().nullable(),
  oldest_create_at: z.number().int().nullable(),
  newest_create_at: z.number().int().nullable(),
  posts_written: z.number().int().nonnegative(),
  /** true quand l API a renvoye une page vide : l historique est epuise. */
  exhausted: z.boolean(),
  /**
   * true une fois le fichier .part retourne en ordre chronologique vers le
   * .ndjson final. Tant que c est false, le canal n est pas consommable.
   */
  finalized: z.boolean(),
  error: z.string().optional(),
});

export type ChannelProgress = z.infer<typeof channelProgressSchema>;

export const extractStateSchema = z.object({
  version: z.number().int().positive(),
  started_at: z.string(),
  updated_at: z.string(),
  /** Verrous d identite : un resume sur une autre instance est refuse. */
  source_url: z.string(),
  account_id: z.string(),
  /**
   * Empreinte des options qui changent la forme de l archive
   * (include_emails, skip_files, max_file_size, since). Un resume avec des
   * options differentes produirait une archive incoherente.
   */
  options_fingerprint: z.string(),
  joined_channels: z.array(joinedChannelRecordSchema),
  joined_teams: z.array(joinedTeamRecordSchema),
  channels: z.record(z.string(), channelProgressSchema),
  downloaded_file_ids: z.array(z.string()),
  skipped_file_ids: z.array(z.string()),
  downloaded_avatar_ids: z.array(z.string()),
  downloaded_emoji_ids: z.array(z.string()),
  fetched_user_ids: z.array(z.string()),
  attachments_bytes: z.number().int().nonnegative(),
  emojis_done: z.boolean(),
  warnings: z.array(archiveWarningSchema),
});

export type ExtractState = z.infer<typeof extractStateSchema>;

export function createEmptyState(input: {
  startedAt: string;
  sourceUrl: string;
  accountId: string;
  optionsFingerprint: string;
}): ExtractState {
  return {
    version: STATE_VERSION,
    started_at: input.startedAt,
    updated_at: input.startedAt,
    source_url: input.sourceUrl,
    account_id: input.accountId,
    options_fingerprint: input.optionsFingerprint,
    joined_channels: [],
    joined_teams: [],
    channels: {},
    downloaded_file_ids: [],
    skipped_file_ids: [],
    downloaded_avatar_ids: [],
    downloaded_emoji_ids: [],
    fetched_user_ids: [],
    attachments_bytes: 0,
    emojis_done: false,
    warnings: [],
  };
}

export function createChannelProgress(): ChannelProgress {
  return {
    status: "pending",
    oldest_post_id: null,
    oldest_create_at: null,
    newest_create_at: null,
    posts_written: 0,
    exhausted: false,
    finalized: false,
  };
}
