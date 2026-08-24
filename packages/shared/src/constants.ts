/**
 * Version du format d archive. A incrementer des qu un changement casse la
 * lecture par un viewer existant.
 */
export const SCHEMA_VERSION = 1;

/** Noms de fichiers et de repertoires du format d archive. */
export const ARCHIVE_LAYOUT = {
  manifest: "manifest.json",
  users: "users.ndjson",
  teams: "teams.ndjson",
  channels: "channels.ndjson",
  emojis: "emojis.ndjson",
  files: "files.ndjson",
  state: ".extract-state.json",
  postsDir: "posts",
  attachmentsDir: "attachments",
  avatarsDir: "avatars",
  emojiDir: "emoji",
} as const;

/**
 * Types de canaux Mattermost.
 * O = public (open), P = prive, D = message direct, G = groupe.
 * mmarchive n archive QUE les canaux de type O.
 */
export const CHANNEL_TYPE = {
  PUBLIC: "O",
  PRIVATE: "P",
  DIRECT: "D",
  GROUP: "G",
} as const;

export type ChannelType = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

/**
 * Types de teams Mattermost. Homonymie trompeuse avec les types de canaux :
 * "O" signifie ici "ouverte a l inscription", pas "publique".
 */
export const TEAM_TYPE = {
  OPEN: "O",
  INVITE_ONLY: "I",
} as const;

export type TeamType = (typeof TEAM_TYPE)[keyof typeof TEAM_TYPE];

/** Longueur d un identifiant Mattermost (26 caracteres, base32 modifiee). */
export const MM_ID_LENGTH = 26;
