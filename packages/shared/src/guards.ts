import { CHANNEL_TYPE, type ChannelType, MM_ID_LENGTH } from "./constants.js";

/**
 * Filtre defensif central. Tout canal qui traverse mmarchive doit passer par
 * ici, quelle que soit sa provenance (API, fichier YAML edite a la main,
 * archive existante). Un canal prive, un DM ou un groupe ne doit jamais
 * pouvoir entrer dans une archive, meme par accident.
 */
export function isPublicChannel(channel: { readonly type?: string | undefined }): boolean {
  return channel.type === CHANNEL_TYPE.PUBLIC;
}

export class NonPublicChannelError extends Error {
  readonly channelId: string;
  readonly channelType: string;

  constructor(channelId: string, channelType: string) {
    super(
      `Canal ${channelId} de type "${channelType}" refuse : mmarchive n archive que les canaux publics (type "O").`,
    );
    this.name = "NonPublicChannelError";
    this.channelId = channelId;
    this.channelType = channelType;
  }
}

/**
 * Variante levante du filtre defensif, a utiliser aux frontieres ou un canal
 * non public signale un bug plutot qu une donnee a ignorer.
 */
export function assertPublicChannel<T extends { readonly id: string; readonly type?: string }>(
  channel: T,
): asserts channel is T & { readonly type: typeof CHANNEL_TYPE.PUBLIC } {
  if (!isPublicChannel(channel)) {
    throw new NonPublicChannelError(channel.id, channel.type ?? "inconnu");
  }
}

/** Un canal archive au sens Mattermost : supprime logiquement, pas efface. */
export function isArchivedChannel(channel: { readonly delete_at?: number | undefined }): boolean {
  return (channel.delete_at ?? 0) !== 0;
}

/** Un compte desactive. Ses messages restent references, il faut le conserver. */
export function isDeactivatedUser(user: { readonly delete_at?: number | undefined }): boolean {
  return (user.delete_at ?? 0) !== 0;
}

export function isMattermostId(value: string): boolean {
  return value.length === MM_ID_LENGTH && /^[a-z0-9]+$/.test(value);
}

export function isChannelType(value: string): value is ChannelType {
  return (Object.values(CHANNEL_TYPE) as string[]).includes(value);
}
