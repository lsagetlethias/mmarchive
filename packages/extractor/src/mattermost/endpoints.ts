/**
 * Catalogue exhaustif des endpoints que mmarchive s autorise a appeler.
 *
 * Le client HTTP n expose AUCUNE methode generique prenant un chemin arbitraire :
 * il n accepte que des EndpointCall construits ici. Ajouter un appel a l API
 * oblige donc a modifier ce fichier, ce qui est visible en relecture. C est le
 * mecanisme qui rend le join implicite impossible par construction, plutot que
 * par discipline.
 *
 * Les trois seuls endpoints en ecriture sont regroupes en fin de fichier et ne
 * peuvent etre executes qu a travers MutationGate.
 */

export type HttpMethod = "GET" | "POST" | "DELETE";

export type QueryValue = string | number | boolean | undefined;

export interface EndpointCall {
  readonly method: HttpMethod;
  /** Chemin concret, relatif a /api/v4, segments dynamiques deja encodes. */
  readonly path: string;
  /** Gabarit sans identifiant, utilise dans les logs et les messages d erreur. */
  readonly template: string;
  /** true si l appel modifie l instance Mattermost. */
  readonly mutates: boolean;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** true si la reponse est un flux binaire et non du JSON. */
  readonly binary?: boolean;
}

/**
 * Encode un segment de chemin. Un identifiant Mattermost ne contient jamais de
 * caractere special, mais un id malformant venant d un YAML edite a la main ne
 * doit pas pouvoir s echapper du chemin.
 */
function seg(value: string): string {
  return encodeURIComponent(value);
}

function read(
  template: string,
  path: string,
  query?: Readonly<Record<string, QueryValue>>,
  binary = false,
): EndpointCall {
  return query === undefined
    ? { method: "GET", template, path, mutates: false, binary }
    : { method: "GET", template, path, mutates: false, query, binary };
}

/**
 * POST qui ne modifie rien. La spec en recense une vingtaine, mmarchive n en
 * utilise que deux. Ils sont declares ici pour que la regle "tout non-GET est
 * refuse" reste appliquable sans exception implicite.
 */
function readViaPost(template: string, path: string, body: unknown): EndpointCall {
  return { method: "POST", template, path, mutates: false, body };
}

function mutation(
  method: "POST" | "DELETE",
  template: string,
  path: string,
  body?: unknown,
): EndpointCall {
  return body === undefined
    ? { method, template, path, mutates: true }
    : { method, template, path, mutates: true, body };
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                     */
/* -------------------------------------------------------------------------- */

export const MM = {
  /** Identite et roles du compte porteur du token. */
  getMe(): EndpointCall {
    return read("/users/me", "/users/me");
  },

  /** Sert a lire le header X-Version-Id : aucun endpoint ne renvoie la version dans son corps. */
  ping(): EndpointCall {
    return read("/system/ping", "/system/ping");
  },

  /**
   * Configuration cliente. Aucun schema de reponse n est declare dans la spec,
   * le contenu est donc traite comme un dictionnaire de chaines.
   */
  getClientConfig(): EndpointCall {
    return read("/config/client", "/config/client", { format: "old" });
  },

  /** Teams dont le compte est membre. Cet endpoint n est pas pagine. */
  getMyTeams(): EndpointCall {
    return read("/users/me/teams", "/users/me/teams");
  },

  /** Catalogue complet des teams. Sert a detecter celles dont on n est pas membre. */
  getAllTeams(page: number, perPage: number): EndpointCall {
    return read("/teams", "/teams", { page, per_page: perPage });
  },

  /** Canaux de la team dont le compte est deja membre. Non pagine. */
  getMyChannelsForTeam(teamId: string): EndpointCall {
    return read("/users/me/teams/{team_id}/channels", `/users/me/teams/${seg(teamId)}/channels`);
  },

  /** Catalogue des canaux publics de la team, y compris non rejoints. */
  getPublicChannelsForTeam(teamId: string, page: number, perPage: number): EndpointCall {
    return read("/teams/{team_id}/channels", `/teams/${seg(teamId)}/channels`, {
      page,
      per_page: perPage,
    });
  },

  /** Canaux archives de la team. Depend de ViewArchivedChannels cote serveur. */
  getDeletedChannelsForTeam(teamId: string, page: number, perPage: number): EndpointCall {
    return read("/teams/{team_id}/channels/deleted", `/teams/${seg(teamId)}/channels/deleted`, {
      page,
      per_page: perPage,
    });
  },

  getChannel(channelId: string): EndpointCall {
    return read("/channels/{channel_id}", `/channels/${seg(channelId)}`);
  },

  /**
   * Endpoint central de l extraction.
   * before et after sont des ids de post, pas des timestamps. Leur inclusivite
   * n est pas documentee : l appelant doit dedupliquer sur les frontieres.
   * Le parametre since de l API est volontairement absent : il selectionne les
   * posts MODIFIES, est plafonne a 1000, et est incompatible avec la pagination.
   */
  getChannelPosts(
    channelId: string,
    options: { perPage: number; before?: string | undefined; after?: string | undefined },
  ): EndpointCall {
    return read("/channels/{channel_id}/posts", `/channels/${seg(channelId)}/posts`, {
      per_page: options.perPage,
      before: options.before,
      after: options.after,
    });
  },

  /**
   * is_pinned n est pas declare dans le schema Post de la spec. Cet endpoint
   * est la source fiable des messages epingles.
   */
  getPinnedPosts(channelId: string): EndpointCall {
    return read("/channels/{channel_id}/pinned", `/channels/${seg(channelId)}/pinned`);
  },

  /** POST de lecture. Resout un lot d identifiants d utilisateurs. */
  getUsersByIds(userIds: readonly string[]): EndpointCall {
    return readViaPost("/users/ids", "/users/ids", userIds);
  },

  /** POST de lecture. Repli pour les serveurs anciens sans post.metadata. */
  getBulkReactions(postIds: readonly string[]): EndpointCall {
    return readViaPost("/posts/ids/reactions", "/posts/ids/reactions", postIds);
  },

  getUserImage(userId: string): EndpointCall {
    return read("/users/{user_id}/image", `/users/${seg(userId)}/image`, undefined, true);
  },

  getCustomEmojis(page: number, perPage: number): EndpointCall {
    return read("/emoji", "/emoji", { page, per_page: perPage, sort: "name" });
  },

  getEmojiImage(emojiId: string): EndpointCall {
    return read("/emoji/{emoji_id}/image", `/emoji/${seg(emojiId)}/image`, undefined, true);
  },

  getFile(fileId: string): EndpointCall {
    return read("/files/{file_id}", `/files/${seg(fileId)}`, undefined, true);
  },

  getFileInfo(fileId: string): EndpointCall {
    return read("/files/{file_id}/info", `/files/${seg(fileId)}/info`);
  },

  /* ------------------------------------------------------------------------ */
  /* Ecriture : les trois SEULES mutations de tout mmarchive.                  */
  /* Chacune publie un message systeme visible dans le canal concerne.         */
  /* Accessibles uniquement via MutationGate, jamais directement.              */
  /* ------------------------------------------------------------------------ */

  /** Rejoint un canal. Publie un message systeme system_join_channel. */
  addChannelMember(channelId: string, userId: string): EndpointCall {
    return mutation(
      "POST",
      "/channels/{channel_id}/members",
      `/channels/${seg(channelId)}/members`,
      { user_id: userId },
    );
  },

  /** Quitte un canal. Publie un second message systeme. */
  removeChannelMember(channelId: string, userId: string): EndpointCall {
    return mutation(
      "DELETE",
      "/channels/{channel_id}/members/{user_id}",
      `/channels/${seg(channelId)}/members/${seg(userId)}`,
    );
  },

  /** Rejoint une team. Prerequis pour lister ses canaux publics. */
  addTeamMember(teamId: string, userId: string): EndpointCall {
    return mutation("POST", "/teams/{team_id}/members", `/teams/${seg(teamId)}/members`, {
      team_id: teamId,
      user_id: userId,
    });
  },
} as const;

/**
 * Gabarits des trois seules mutations declarees. Un test verifie que le
 * catalogue n en contient pas d autres : si quelqu un ajoute un endpoint
 * mutant, le test casse et la relecture est forcee.
 */
export const DECLARED_MUTATION_TEMPLATES: readonly string[] = [
  "/channels/{channel_id}/members",
  "/channels/{channel_id}/members/{user_id}",
  "/teams/{team_id}/members",
];
