import { z } from "zod";

/**
 * Types des reponses de l API Mattermost v4 reellement consommees par mmarchive.
 *
 * Les schemas sont volontairement PERMISSIFS : la spec OpenAPI officielle ne
 * declare presque aucun champ comme requis, et diverge du serveur reel sur
 * plusieurs points (voir les commentaires ci-dessous). Une validation stricte
 * ferait echouer une extraction de plusieurs heures sur un champ cosmetique.
 * On valide ce dont on depend, on laisse passer le reste.
 */

const looseObject = z.record(z.string(), z.unknown());

export const mmUserSchema = z
  .object({
    id: z.string(),
    username: z.string().default(""),
    nickname: z.string().default(""),
    first_name: z.string().default(""),
    last_name: z.string().default(""),
    position: z.string().default(""),
    roles: z.string().default(""),
    email: z.string().optional(),
    create_at: z.number().default(0),
    delete_at: z.number().default(0),
    /**
     * Absent de la spec OpenAPI (zero occurrence dans les 12 fichiers sources)
     * mais renvoye par le serveur. On le lit s il est la, et on retombe sur
     * roles qui contient "system_bot" sinon.
     */
    is_bot: z.boolean().optional(),
    bot_description: z.string().optional(),
  })
  .passthrough();

export type MmUser = z.infer<typeof mmUserSchema>;

export function isBotUser(user: MmUser): boolean {
  if (user.is_bot !== undefined) return user.is_bot;
  return user.roles.split(" ").includes("system_bot");
}

export function isSystemAdmin(user: MmUser): boolean {
  // roles est separe par des ESPACES sur l objet User, contrairement au filtre
  // ?roles= de GET /users qui utilise des virgules.
  return user.roles.split(" ").includes("system_admin");
}

export const mmChannelSchema = z
  .object({
    id: z.string(),
    team_id: z.string().default(""),
    type: z.string(),
    display_name: z.string().default(""),
    name: z.string().default(""),
    header: z.string().default(""),
    purpose: z.string().default(""),
    create_at: z.number().default(0),
    delete_at: z.number().default(0),
    last_post_at: z.number().default(0),
    total_msg_count: z.number().default(0),
  })
  .passthrough();

export type MmChannel = z.infer<typeof mmChannelSchema>;

export const mmTeamSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    display_name: z.string().default(""),
    description: z.string().default(""),
    type: z.string().default(""),
    create_at: z.number().default(0),
    delete_at: z.number().default(0),
  })
  .passthrough();

export type MmTeam = z.infer<typeof mmTeamSchema>;

export const mmReactionSchema = z
  .object({
    user_id: z.string(),
    post_id: z.string().default(""),
    emoji_name: z.string(),
    create_at: z.number().default(0),
  })
  .passthrough();

export type MmReaction = z.infer<typeof mmReactionSchema>;

export const mmFileInfoSchema = z
  .object({
    id: z.string(),
    user_id: z.string().default(""),
    post_id: z.string().default(""),
    create_at: z.number().default(0),
    update_at: z.number().default(0),
    delete_at: z.number().default(0),
    name: z.string().default(""),
    extension: z.string().default(""),
    size: z.number().default(0),
    mime_type: z.string().default(""),
    width: z.number().default(0),
    height: z.number().default(0),
    has_preview_image: z.boolean().default(false),
  })
  .passthrough();

export type MmFileInfo = z.infer<typeof mmFileInfoSchema>;

export const mmEmojiSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    creator_id: z.string().default(""),
    create_at: z.number().default(0),
    update_at: z.number().default(0),
    delete_at: z.number().default(0),
  })
  .passthrough();

export type MmEmoji = z.infer<typeof mmEmojiSchema>;

/**
 * Les collections de PostMetadata valent null, pas [], quand elles sont vides.
 * C est documente dans la spec pour reactions, embeds, emojis, files et images.
 */
export const mmPostMetadataSchema = z
  .object({
    reactions: z.array(mmReactionSchema).nullish(),
    files: z.array(mmFileInfoSchema).nullish(),
    emojis: z.array(mmEmojiSchema).nullish(),
  })
  .passthrough();

export type MmPostMetadata = z.infer<typeof mmPostMetadataSchema>;

export const mmPostSchema = z
  .object({
    id: z.string(),
    create_at: z.number().default(0),
    update_at: z.number().default(0),
    edit_at: z.number().default(0),
    delete_at: z.number().default(0),
    user_id: z.string().default(""),
    channel_id: z.string().default(""),
    root_id: z.string().default(""),
    message: z.string().default(""),
    type: z.string().default(""),
    props: looseObject.nullish(),
    file_ids: z.array(z.string()).nullish(),
    metadata: mmPostMetadataSchema.nullish(),
    /**
     * La spec nomme ce champ "hashtag" au singulier, le serveur renvoie
     * "hashtags" au pluriel. On accepte les deux et on normalise.
     */
    hashtags: z.string().optional(),
    hashtag: z.string().optional(),
    /**
     * Absent du schema Post de la spec : il n existe qu en corps de requete de
     * UpdatePost et PatchPost. Le serveur le renvoie, mais on ne peut pas s y
     * fier, d ou le complement par GET /channels/{id}/pinned.
     */
    is_pinned: z.boolean().optional(),
  })
  .passthrough();

export type MmPost = z.infer<typeof mmPostSchema>;

/**
 * PostList.posts est une MAP post_id vers Post, pas un tableau. L ordre vit
 * dans le tableau order. C est le piege numero un de cette API.
 */
export const mmPostListSchema = z
  .object({
    order: z.array(z.string()).default([]),
    posts: z.record(z.string(), mmPostSchema).default({}),
    next_post_id: z.string().optional(),
    prev_post_id: z.string().optional(),
    has_next: z.boolean().optional(),
  })
  .passthrough();

export type MmPostList = z.infer<typeof mmPostListSchema>;

/**
 * Reconstitue les posts d une PostList dans l ordre du tableau order, en
 * ignorant les ids orphelins. Le sens de tri de order n est PAS documente pour
 * GET /channels/{id}/posts : l appelant doit trier lui-meme sur create_at.
 */
export function postsInOrder(list: MmPostList): MmPost[] {
  const result: MmPost[] = [];
  for (const id of list.order) {
    const post = list.posts[id];
    if (post) result.push(post);
  }
  return result;
}

export function normalizedHashtags(post: MmPost): string {
  return post.hashtags ?? post.hashtag ?? "";
}

export const mmChannelListSchema = z.array(mmChannelSchema);
export const mmTeamListSchema = z.array(mmTeamSchema);
export const mmUserListSchema = z.array(mmUserSchema);
export const mmEmojiListSchema = z.array(mmEmojiSchema);
