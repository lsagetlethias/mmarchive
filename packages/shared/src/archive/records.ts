import { z } from "zod";
import { CHANNEL_TYPE } from "../constants.js";

/** Timestamp Mattermost : millisecondes depuis epoch. 0 signifie "jamais". */
const timestamp = z.number().int().nonnegative();

const mmId = z.string().min(1);

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

export const archiveReactionSchema = z.object({
  user_id: mmId,
  emoji_name: z.string(),
  create_at: timestamp,
});

export type ArchiveReaction = z.infer<typeof archiveReactionSchema>;

/* -------------------------------------------------------------------------- */
/* Posts                                                                       */
/* -------------------------------------------------------------------------- */

export const archivePostSchema = z.object({
  id: mmId,
  channel_id: mmId,
  user_id: z.string(),
  create_at: timestamp,
  update_at: timestamp,
  /** Non nul si le message a ete edite. L historique d edition est perdu. */
  edit_at: timestamp,
  delete_at: timestamp,
  /** Vide pour un message racine, sinon l id du message racine du fil. */
  root_id: z.string(),
  /** Vide pour un message normal, "system_*" pour un message systeme. */
  type: z.string(),
  message: z.string(),
  is_pinned: z.boolean(),
  hashtags: z.string(),
  props: z.record(z.string(), z.unknown()),
  file_ids: z.array(mmId),
  reactions: z.array(archiveReactionSchema),
});

export type ArchivePost = z.infer<typeof archivePostSchema>;

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export const archiveUserSchema = z.object({
  id: mmId,
  username: z.string(),
  nickname: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  position: z.string(),
  roles: z.string(),
  is_bot: z.boolean(),
  create_at: timestamp,
  /** Non nul si le compte est desactive. Le user est conserve malgre tout. */
  delete_at: timestamp,
  /** Chemin relatif a la racine de l archive, absent si l avatar a echoue. */
  avatar: z.string().nullable(),
  /** Present uniquement si l extraction a ete lancee avec --include-emails. */
  email: z.string().optional(),
});

export type ArchiveUser = z.infer<typeof archiveUserSchema>;

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

export const archiveChannelSchema = z.object({
  id: mmId,
  team_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  /** Toujours "O". Le format n admet aucun autre type. */
  type: z.literal(CHANNEL_TYPE.PUBLIC),
  header: z.string(),
  purpose: z.string(),
  create_at: timestamp,
  /** Non nul si le canal est archive cote Mattermost. */
  delete_at: timestamp,
  total_msg_count: z.number().int().nonnegative(),
  last_post_at: timestamp,
  /** true si mmarchive a du rejoindre ce canal pour le lire. */
  was_joined_by_tool: z.boolean(),
  /** Nombre de posts reellement ecrits dans posts/<id>.ndjson. */
  archived_post_count: z.number().int().nonnegative(),
});

export type ArchiveChannel = z.infer<typeof archiveChannelSchema>;

/* -------------------------------------------------------------------------- */
/* Teams                                                                       */
/* -------------------------------------------------------------------------- */

export const archiveTeamSchema = z.object({
  id: mmId,
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  /** "O" = ouverte a l inscription, "I" = sur invitation. Sans rapport avec le type de canal. */
  type: z.string(),
  create_at: timestamp,
  delete_at: timestamp,
  /** true si mmarchive a du rejoindre cette team (--join-teams). */
  was_joined_by_tool: z.boolean(),
});

export type ArchiveTeam = z.infer<typeof archiveTeamSchema>;

/* -------------------------------------------------------------------------- */
/* Emojis custom                                                               */
/* -------------------------------------------------------------------------- */

export const archiveEmojiSchema = z.object({
  id: mmId,
  name: z.string(),
  creator_id: z.string(),
  create_at: timestamp,
  update_at: timestamp,
  delete_at: timestamp,
  /** Chemin relatif a la racine de l archive, null si l image a echoue. */
  image: z.string().nullable(),
});

export type ArchiveEmoji = z.infer<typeof archiveEmojiSchema>;

/* -------------------------------------------------------------------------- */
/* Fichiers joints                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Raison pour laquelle le contenu binaire d un fichier est absent de l archive
 * alors que sa metadonnee est conservee.
 */
export const fileSkipReasonSchema = z.enum([
  /** Extraction lancee avec --skip-files. */
  "skipped_by_option",
  /** Taille superieure a --max-file-size. */
  "too_large",
  /** Telechargement refuse par le serveur (403, 404). */
  "forbidden",
  /** Echec reseau persistant apres retries. */
  "download_failed",
]);

export type FileSkipReason = z.infer<typeof fileSkipReasonSchema>;

export const archiveFileSchema = z.object({
  id: mmId,
  post_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  name: z.string(),
  extension: z.string(),
  size: z.number().int().nonnegative(),
  mime_type: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  has_preview_image: z.boolean(),
  create_at: timestamp,
  delete_at: timestamp,
  /**
   * Chemin relatif du binaire dans l archive, null si le contenu n a pas ete
   * telecharge. La metadonnee est conservee dans tous les cas pour que le
   * viewer puisse afficher "piece jointe non archivee" plutot que rien.
   */
  path: z.string().nullable(),
  skip_reason: fileSkipReasonSchema.optional(),
});

export type ArchiveFile = z.infer<typeof archiveFileSchema>;
