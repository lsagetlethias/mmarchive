import { z } from "zod";

const timestamp = z.number().int().nonnegative();
const isoDate = z.string().min(1);

/**
 * Codes de warning consignes dans le manifest. Le but est qu un lecteur futur
 * de l archive puisse auditer ce qui manque et pourquoi, sans avoir acces aux
 * logs du run.
 */
export const warningCodeSchema = z.enum([
  /** Canal archive dont la lecture a ete refusee (ViewArchivedChannels desactive). */
  "ARCHIVED_CHANNEL_FORBIDDEN",
  /** Canal public non lisible malgre la selection (droits insuffisants). */
  "CHANNEL_FORBIDDEN",
  /** Team dont le compte n est pas membre : ses canaux publics sont invisibles. */
  "TEAM_NOT_MEMBER",
  /** Un post reference un root_id absent du canal extrait. */
  "ORPHAN_THREAD_ROOT",
  /** Piece jointe ignoree car au dessus de --max-file-size. */
  "FILE_TOO_LARGE",
  "FILE_DOWNLOAD_FAILED",
  "AVATAR_DOWNLOAD_FAILED",
  "EMOJI_DOWNLOAD_FAILED",
  "USER_FETCH_FAILED",
  /**
   * Fiche d un canal ou d une team illisible.
   *
   * Sur un canal, `header`, `purpose` et `create_at` restent vides ou a zero ;
   * sur une team, `description`, `type` et `create_at`. Le reste de
   * l enregistrement est complet, et les messages ne sont pas affectes.
   */
  "METADATA_FETCH_FAILED",
  /** Serveur ancien sans post.metadata : reactions recuperees separement. */
  "POST_METADATA_MISSING",
  /** Une entree non publique a ete rejetee par le filtre defensif. */
  "NON_PUBLIC_CHANNEL_REJECTED",
  /** Canal dont l extraction s est arretee avant la fin. */
  "CHANNEL_INCOMPLETE",
  /** Echec au moment de quitter un canal rejoint (--leave-after). */
  "LEAVE_FAILED",
]);

export type WarningCode = z.infer<typeof warningCodeSchema>;

export const archiveWarningSchema = z.object({
  code: warningCodeSchema,
  channel_id: z.string().optional(),
  team_id: z.string().optional(),
  detail: z.string(),
});

export type ArchiveWarning = z.infer<typeof archiveWarningSchema>;

/** Trace d un canal rejoint par l outil, pour pouvoir auditer l effet de bord. */
export const joinedChannelRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  team_id: z.string(),
  joined_at: isoDate,
  left: z.boolean(),
  left_at: isoDate.optional(),
});

export type JoinedChannelRecord = z.infer<typeof joinedChannelRecordSchema>;

export const joinedTeamRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  joined_at: isoDate,
});

export type JoinedTeamRecord = z.infer<typeof joinedTeamRecordSchema>;

/**
 * Trace d un passage par `mmarchive-anonymize`. Absent d une archive d origine.
 *
 * Elle dit une fois, en un endroit, ce qu il faudrait autrement repeter sur
 * chaque ligne de `files.ndjson` au prix d une valeur ajoutee a un enum ferme.
 * Elle dit aussi jusqu ou l anonymisation est allee, par ce qu elle enumere : un
 * lecteur qui ne trouve pas `noms` dans `text_rewritten` sait que le corps des
 * messages porte encore des noms ecrits en clair, et qu il ne tient donc pas une
 * archive diffusable.
 */
/**
 * Surfaces et formes que cette version sait reecrire.
 *
 * Ce sont des TYPES et non des schemas de validation, et la distinction est le
 * fond du sujet. Un `z.enum` ferait echouer la lecture d une archive produite
 * par une version ulterieure qui aurait ajoute une forme, alors que la section
 * « compatibilite et evolution » du format impose a un lecteur d ignorer ce qu il
 * ne connait pas. Le type contraint ce que l outil ECRIT ; la validation accepte
 * ce qu il LIT.
 *
 * `noms` n y figure pas tant que le remplacement des noms ecrits en clair n est
 * pas livre : le manifeste ne doit pas pouvoir affirmer un travail qui n existe
 * pas.
 */
export type RewrittenSurface = "message" | "props.attachments";
export type RewrittenForm = "mentions" | "adresses" | "telephones" | "identifiants";

export const anonymizationRecordSchema = z.object({
  at: isoDate,
  tool_version: z.string(),
  /** Pieces jointes, avatars et emojis personnalises non repris. */
  binaries_removed: z.boolean(),
  /**
   * Ce qui a ETE FAIT, par surface. Jamais ce qui reste.
   *
   * Un booleen unique ne pouvait plus rien dire de vrai : il ne nommait qu une
   * des deux surfaces reecrites, et il aurait fallu le mettre a vrai alors que
   * les noms ecrits en clair subsistent, ce qui ferait croire l archive
   * diffusable. Enumerer les formes traitees rend l ecart visible sans avoir a
   * le commenter, et une liste de residus vides se lirait un jour comme le
   * verdict positif que le rapport s interdit par ailleurs.
   */
  text_rewritten: z.record(z.string(), z.array(z.string())),
});

export type AnonymizationRecord = z.infer<typeof anonymizationRecordSchema>;

/** "file" = selection issue d un YAML, "accessible" = mode sur par defaut. */
export const selectionModeSchema = z.enum(["file", "accessible"]);

export type SelectionMode = z.infer<typeof selectionModeSchema>;

export const manifestSchema = z.object({
  schema_version: z.number().int().positive(),
  tool_version: z.string(),
  source: z.object({
    url: z.string(),
    server_version: z.string(),
  }),
  extracted_at: isoDate,
  extracted_by: z.object({
    user_id: z.string(),
    username: z.string(),
    was_system_admin: z.boolean(),
  }),
  selection: z.object({
    mode: selectionModeSchema,
    /**
     * Nombre total de canaux publics visibles sur l instance au moment de
     * l inventaire. Sert a auditer la completude : l ecart avec
     * channels_selected est ce que l archive ne contient pas.
     */
    channels_total_public: z.number().int().nonnegative(),
    channels_selected: z.number().int().nonnegative(),
    channels_already_member: z.number().int().nonnegative(),
    channels_joined_by_tool: z.number().int().nonnegative(),
    channels_archived: z.number().int().nonnegative(),
  }),
  options: z.object({
    include_emails: z.boolean(),
    skip_files: z.boolean(),
    leave_after: z.boolean(),
    max_file_size_mb: z.number().nonnegative(),
    concurrency: z.number().int().positive(),
    rate_limit: z.number().positive(),
    /** Borne basse d une extraction incrementale, absente sinon. */
    since: isoDate.optional(),
  }),
  joined_channels: z.array(joinedChannelRecordSchema),
  joined_teams: z.array(joinedTeamRecordSchema),
  counts: z.object({
    teams: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    posts: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    emojis: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
    attachments_bytes: z.number().int().nonnegative(),
  }),
  /** Plage temporelle couverte par les posts extraits. */
  post_range: z
    .object({
      first_create_at: timestamp,
      last_create_at: timestamp,
    })
    .optional(),
  warnings: z.array(archiveWarningSchema),
  anonymized: anonymizationRecordSchema.optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;
