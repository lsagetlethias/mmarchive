import { isPublicChannel } from "@mmarchive/shared";
import { z } from "zod";
import { MM } from "./endpoints.js";
import { MattermostForbiddenError, MattermostNotFoundError } from "./errors.js";
import type { BinaryResponse, MattermostClient } from "./http-client.js";
import {
  type MmChannel,
  type MmEmoji,
  type MmFileInfo,
  type MmPostList,
  type MmTeam,
  type MmUser,
  mmChannelListSchema,
  mmEmojiListSchema,
  mmFileInfoSchema,
  mmPostListSchema,
  mmTeamListSchema,
  mmUserListSchema,
  mmUserSchema,
} from "./types.js";

/**
 * Taille de page des listings. La spec ne declare aucun maximum de schema ;
 * seules trois descriptions mentionnent 200 en prose. On s y tient partout,
 * c est la seule borne documentee de l API.
 */
export const LIST_PAGE_SIZE = 200;

/**
 * Taille de page des posts. Aucun maximum n est documente pour cet endpoint,
 * qui est pourtant le plus critique. 200 est la valeur historique du serveur ;
 * si l instance plafonne plus bas, la boucle de pagination le supporte
 * naturellement puisqu elle avance sur l id du plus ancien post recu.
 */
export const POSTS_PAGE_SIZE = 200;

/** Lots de resolution d utilisateurs. Aucune limite n est documentee, 100 est prudent. */
export const USER_BATCH_SIZE = 100;

/** Sonde de lisibilite : une seule ligne suffit a savoir si l acces passe. */
const PROBE_PAGE_SIZE = 1;

const clientConfigSchema = z.record(z.string(), z.unknown());

/**
 * Certains listings renvoient soit un tableau brut, soit une enveloppe
 * { items, total_count }, selon des parametres et sans que le schema declare le
 * dise. On normalise a l execution plutot que de faire confiance a la spec.
 */
function unwrapList<T>(
  raw: unknown,
  key: string,
  schema: z.ZodType<T[], z.ZodTypeDef, unknown>,
): T[] {
  if (Array.isArray(raw)) return schema.parse(raw);
  if (typeof raw === "object" && raw !== null && key in raw) {
    const inner = (raw as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return schema.parse(inner);
  }
  return schema.parse(raw);
}

export class MattermostApi {
  private readonly client: MattermostClient;

  constructor(client: MattermostClient) {
    this.client = client;
  }

  get serverVersion(): string {
    return this.client.serverVersion ?? "inconnue";
  }

  async getMe(): Promise<MmUser> {
    return this.client.json(MM.getMe(), mmUserSchema);
  }

  /**
   * Aucun endpoint ne renvoie la version du serveur dans son corps : elle
   * arrive dans le header X-Version-Id, que le client memorise a chaque
   * reponse. Ce ping sert uniquement a l obtenir tot.
   */
  async detectServerVersion(): Promise<string> {
    await this.client.json(MM.ping(), z.unknown());
    return this.serverVersion;
  }

  async getClientConfig(): Promise<Record<string, unknown>> {
    try {
      return await this.client.json(MM.getClientConfig(), clientConfigSchema);
    } catch {
      // Cette configuration est un confort de diagnostic, jamais un prerequis.
      return {};
    }
  }

  async getMyTeams(): Promise<MmTeam[]> {
    return this.client.json(MM.getMyTeams(), mmTeamListSchema);
  }

  async getAllTeams(): Promise<MmTeam[]> {
    return this.paginate((page) =>
      this.client
        .json(MM.getAllTeams(page, LIST_PAGE_SIZE), z.unknown())
        .then((raw) => unwrapList(raw, "teams", mmTeamListSchema)),
    );
  }

  /** Canaux de la team dont le compte est deja membre. Cet endpoint n est pas pagine. */
  async getMyChannelsForTeam(teamId: string): Promise<MmChannel[]> {
    const channels = await this.client.json(MM.getMyChannelsForTeam(teamId), mmChannelListSchema);
    return channels.filter(isPublicChannel);
  }

  /** Catalogue des canaux publics de la team, rejoints ou non. */
  async getPublicChannelsForTeam(teamId: string): Promise<MmChannel[]> {
    const channels = await this.paginate((page) =>
      this.client
        .json(MM.getPublicChannelsForTeam(teamId, page, LIST_PAGE_SIZE), z.unknown())
        .then((raw) => unwrapList(raw, "channels", mmChannelListSchema)),
    );
    return channels.filter(isPublicChannel);
  }

  /**
   * Canaux archives de la team. Renvoie une liste vide plutot qu une erreur si
   * le serveur refuse : ViewArchivedChannels peut etre desactive, ce qui est une
   * configuration legitime et pas un echec d extraction.
   */
  async getDeletedChannelsForTeam(teamId: string): Promise<MmChannel[]> {
    try {
      const channels = await this.paginate((page) =>
        this.client
          .json(MM.getDeletedChannelsForTeam(teamId, page, LIST_PAGE_SIZE), z.unknown())
          .then((raw) => unwrapList(raw, "channels", mmChannelListSchema)),
      );
      return channels.filter(isPublicChannel);
    } catch (error) {
      if (error instanceof MattermostForbiddenError || error instanceof MattermostNotFoundError) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Determine si un canal est lisible, en une requete et sans aucune ecriture.
   *
   * On sonde au lieu de deduire des roles : la spec ne garantit nulle part
   * qu un system admin non membre puisse lire un canal public, et les schemes de
   * permissions personnalises rendent toute deduction fragile. Un sondage coute
   * une requete et donne la reponse vraie.
   */
  async probeChannelReadable(channelId: string): Promise<boolean> {
    try {
      await this.client.json(
        MM.getChannelPosts(channelId, { perPage: PROBE_PAGE_SIZE }),
        mmPostListSchema,
      );
      return true;
    } catch (error) {
      if (error instanceof MattermostForbiddenError || error instanceof MattermostNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async getChannelPostsPage(
    channelId: string,
    options: { perPage?: number | undefined; before?: string | undefined },
  ): Promise<MmPostList> {
    return this.client.json(
      MM.getChannelPosts(channelId, {
        perPage: options.perPage ?? POSTS_PAGE_SIZE,
        before: options.before,
      }),
      mmPostListSchema,
    );
  }

  /**
   * is_pinned n est pas declare dans le schema Post de la spec. Cet endpoint est
   * la seule source fiable, on l interroge une fois par canal.
   */
  async getPinnedPostIds(channelId: string): Promise<Set<string>> {
    try {
      const list = await this.client.json(MM.getPinnedPosts(channelId), mmPostListSchema);
      return new Set(list.order);
    } catch (error) {
      if (error instanceof MattermostForbiddenError || error instanceof MattermostNotFoundError) {
        return new Set();
      }
      throw error;
    }
  }

  async getUsersByIds(userIds: readonly string[]): Promise<MmUser[]> {
    const found: MmUser[] = [];
    for (let index = 0; index < userIds.length; index += USER_BATCH_SIZE) {
      const batch = userIds.slice(index, index + USER_BATCH_SIZE);
      if (batch.length === 0) continue;
      const users = await this.client.json(MM.getUsersByIds(batch), mmUserListSchema);
      found.push(...users);
    }
    return found;
  }

  async getCustomEmojis(): Promise<MmEmoji[]> {
    return this.paginate((page) =>
      this.client.json(MM.getCustomEmojis(page, LIST_PAGE_SIZE), mmEmojiListSchema),
    );
  }

  /**
   * Metadonnee d une piece jointe isolee. Sert a rattraper les fichiers
   * referencees par un message dont la metadonnee n a jamais ete ecrite, faute
   * de quoi le viewer afficherait une reference vers le vide.
   */
  async getFileInfo(fileId: string): Promise<MmFileInfo | null> {
    try {
      return await this.client.json(MM.getFileInfo(fileId), mmFileInfoSchema);
    } catch (error) {
      if (error instanceof MattermostForbiddenError || error instanceof MattermostNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async downloadFile(fileId: string): Promise<BinaryResponse> {
    return this.client.binary(MM.getFile(fileId));
  }

  async downloadAvatar(userId: string): Promise<BinaryResponse> {
    return this.client.binary(MM.getUserImage(userId));
  }

  async downloadEmojiImage(emojiId: string): Promise<BinaryResponse> {
    return this.client.binary(MM.getEmojiImage(emojiId));
  }

  /**
   * Boucle sur page jusqu a recevoir moins d elements que la taille de page.
   * C est la seule strategie que la spec supporte partout : aucun total_count
   * n est fiable sur les listings par team, et il n existe pas de curseur.
   */
  private async paginate<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; ; page += 1) {
      const items = await fetchPage(page);
      all.push(...items);
      if (items.length < LIST_PAGE_SIZE) return all;
    }
  }
}
