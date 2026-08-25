import { z } from "zod";
import { CHANNEL_TYPE } from "./constants.js";

/**
 * Modele du fichier de selection (channels.yaml). C est le seul endroit ou
 * l utilisateur designe les canaux a extraire. Aucun canal n est extrait, et
 * surtout aucun canal n est rejoint, sans y figurer avec selected: true.
 */

export const selectionChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  display_name: z.string(),
  /** Toujours "O" : le format de selection n admet que des canaux publics. */
  type: z.literal(CHANNEL_TYPE.PUBLIC).default(CHANNEL_TYPE.PUBLIC),
  /** true si le compte est deja membre du canal. Un join est alors inutile. */
  joined: z.boolean(),
  /** true si le canal est archive cote Mattermost. Un canal archive n est pas joignable. */
  archived: z.boolean(),
  /**
   * Resultat du sondage de lisibilite (une requete posts?per_page=1).
   * undefined si le canal n a pas ete sonde, ce qui est le cas des canaux non
   * rejoints et non archives : on sait deja qu ils ne sont pas lisibles.
   */
  readable: z.boolean().optional(),
  message_count: z.number().int().nonnegative(),
  last_post_at: z.string().optional(),
  /** Le seul champ que l utilisateur est cense modifier. */
  selected: z.boolean(),
});

export type SelectionChannel = z.infer<typeof selectionChannelSchema>;

export const selectionTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  display_name: z.string(),
  /** true si le compte est membre de la team. Sinon ses canaux sont invisibles. */
  joined: z.boolean(),
  channels: z.array(selectionChannelSchema),
});

export type SelectionTeam = z.infer<typeof selectionTeamSchema>;

/**
 * Bloc de tracabilite. Il permet au sous-commande run de refuser un fichier de
 * selection genere depuis une AUTRE instance que celle visee, ce qui eviterait
 * de joindre des canaux au hasard avec le mauvais token.
 */
export const selectionMetaSchema = z.object({
  generated_at: z.string(),
  tool_version: z.string(),
  source_url: z.string(),
  account: z.object({
    user_id: z.string(),
    username: z.string(),
    is_system_admin: z.boolean(),
  }),
});

export type SelectionMeta = z.infer<typeof selectionMetaSchema>;

export const selectionFileSchema = z.object({
  meta: selectionMetaSchema,
  teams: z.array(selectionTeamSchema),
});

export type SelectionFile = z.infer<typeof selectionFileSchema>;

/* -------------------------------------------------------------------------- */
/* Categorisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Categorie d acces d un canal, calculee et jamais stockee. C est elle qui
 * determine si cocher un canal declenche un effet de bord sur l instance.
 */
export type ChannelCategory =
  /** Deja membre : lisible immediatement, aucun effet de bord. */
  | "member"
  /** Lisible sans etre membre : compte system admin, ou sondage concluant. */
  | "readable_without_join"
  /** Non lisible en l etat : l extraire publiera un message systeme dans le canal. */
  | "join_required"
  /** Archive et lisible : non joignable, mais extractible tel quel. */
  | "archived_readable"
  /** Archive et non lisible : rien a faire, le canal est perdu pour l archive. */
  | "archived_unreadable";

export interface ChannelAccessInput {
  readonly joined: boolean;
  readonly archived: boolean;
  readonly readable?: boolean | undefined;
}

export function categorizeChannel(channel: ChannelAccessInput): ChannelCategory {
  if (channel.archived) {
    // Un canal archive n est jamais joignable. Seul le sondage tranche.
    return channel.joined || channel.readable === true
      ? "archived_readable"
      : "archived_unreadable";
  }
  if (channel.joined) return "member";
  if (channel.readable === true) return "readable_without_join";
  return "join_required";
}

/** Un canal peut-il etre extrait, eventuellement au prix d un join ? */
export function isExtractable(channel: ChannelAccessInput): boolean {
  return categorizeChannel(channel) !== "archived_unreadable";
}

/** Cocher ce canal declenchera-t-il un join, donc un message systeme public ? */
export function requiresJoin(channel: ChannelAccessInput): boolean {
  return categorizeChannel(channel) === "join_required";
}

export interface SelectionDefaultsOptions {
  /**
   * Pre-coche aussi les canaux archives lisibles. Ils ne coutent aucun join,
   * mais restent decoches par defaut : embarquer l historique d un canal mort
   * est une decision d archivage, pas un automatisme.
   */
  readonly includeArchivedReadable?: boolean | undefined;
}

/**
 * Valeur par defaut de `selected` a la generation de l inventaire.
 * Regle stricte : jamais de selection par defaut qui declencherait un join.
 */
export function defaultSelected(
  channel: ChannelAccessInput,
  options?: SelectionDefaultsOptions,
): boolean {
  const category = categorizeChannel(channel);
  if (category === "member" || category === "readable_without_join") return true;
  if (category === "archived_readable" && options?.includeArchivedReadable === true) {
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Agregation                                                                  */
/* -------------------------------------------------------------------------- */

export interface SelectionSummary {
  readonly channelsTotal: number;
  readonly channelsSelected: number;
  readonly channelsAlreadyMember: number;
  readonly channelsArchived: number;
  /** Canaux selectionnes qui declencheront un join. Le chiffre qui compte. */
  readonly joinsInduced: number;
  /** Canaux selectionnes mais illisibles : ils seront ignores a l extraction. */
  readonly unreadableSelected: number;
  readonly estimatedMessages: number;
  /** Teams non rejointes contenant au moins un canal selectionne. */
  readonly teamsRequiringJoin: readonly string[];
  readonly channelsRequiringJoin: readonly SelectionChannel[];
}

export function summarizeSelection(file: {
  readonly teams: readonly SelectionTeam[];
}): SelectionSummary {
  let channelsTotal = 0;
  let channelsSelected = 0;
  let channelsAlreadyMember = 0;
  let channelsArchived = 0;
  let unreadableSelected = 0;
  let estimatedMessages = 0;
  const channelsRequiringJoin: SelectionChannel[] = [];
  const teamsRequiringJoin = new Set<string>();

  for (const team of file.teams) {
    for (const channel of team.channels) {
      channelsTotal += 1;
      if (channel.archived) channelsArchived += 1;
      if (channel.joined) channelsAlreadyMember += 1;
      if (!channel.selected) continue;

      channelsSelected += 1;
      estimatedMessages += channel.message_count;

      const category = categorizeChannel(channel);
      if (category === "archived_unreadable") {
        unreadableSelected += 1;
        continue;
      }
      if (category === "join_required") {
        channelsRequiringJoin.push(channel);
        if (!team.joined) teamsRequiringJoin.add(team.id);
      }
    }
  }

  return {
    channelsTotal,
    channelsSelected,
    channelsAlreadyMember,
    channelsArchived,
    joinsInduced: channelsRequiringJoin.length,
    unreadableSelected,
    estimatedMessages,
    teamsRequiringJoin: [...teamsRequiringJoin],
    channelsRequiringJoin,
  };
}
