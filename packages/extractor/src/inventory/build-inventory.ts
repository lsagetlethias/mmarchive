import {
  CHANNEL_TYPE,
  defaultSelected,
  isArchivedChannel,
  isPublicChannel,
  summarizeSelection,
  type ArchiveWarning,
  type SelectionChannel,
  type SelectionFile,
  type SelectionSummary,
  type SelectionTeam,
} from "@mmarchive/shared";
import type { MattermostApi } from "../mattermost/api.js";
import { isSystemAdmin, type MmChannel, type MmTeam, type MmUser } from "../mattermost/types.js";

export interface InventoryProgress {
  readonly phase: "teams" | "channels" | "probe";
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

export interface BuildInventoryOptions {
  readonly api: MattermostApi;
  readonly toolVersion: string;
  readonly sourceUrl: string;
  /**
   * Sonde les canaux non rejoints pour determiner s ils sont lisibles sans
   * join. Coute une requete en LECTURE par canal, aucune ecriture.
   */
  readonly probeUnjoined?: boolean | undefined;
  readonly onProgress?: ((progress: InventoryProgress) => void) | undefined;
  readonly clock?: (() => string) | undefined;
}

export interface InventoryResult {
  readonly file: SelectionFile;
  readonly summary: SelectionSummary;
  readonly warnings: readonly ArchiveWarning[];
  /** Teams visibles sur l instance dont le compte n est pas membre. */
  readonly teamsNotJoined: readonly MmTeam[];
  readonly account: MmUser;
  readonly serverVersion: string;
}

function toIsoOrUndefined(millis: number): string | undefined {
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return new Date(millis).toISOString();
}

function toSelectionChannel(
  channel: MmChannel,
  input: { joined: boolean; archived: boolean; readable: boolean | undefined },
): SelectionChannel {
  const base = {
    id: channel.id,
    name: channel.name,
    display_name: channel.display_name,
    type: CHANNEL_TYPE.PUBLIC,
    joined: input.joined,
    archived: input.archived,
    message_count: channel.total_msg_count,
    selected: defaultSelected(input),
  } satisfies Omit<SelectionChannel, "readable" | "last_post_at">;

  const lastPostAt = toIsoOrUndefined(channel.last_post_at);
  return {
    ...base,
    ...(input.readable === undefined ? {} : { readable: input.readable }),
    ...(lastPostAt === undefined ? {} : { last_post_at: lastPostAt }),
  };
}

/**
 * Construit l inventaire complet des canaux publics visibles.
 *
 * Cette fonction n emet QUE des lectures. Elle ne rejoint rien, ne marque rien
 * comme lu, et ne modifie aucune preference. C est la garantie centrale de la
 * sous-commande inventory.
 */
export async function buildInventory(options: BuildInventoryOptions): Promise<InventoryResult> {
  const { api } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  const probeUnjoined = options.probeUnjoined ?? true;
  const warnings: ArchiveWarning[] = [];

  const account = await api.getMe();
  const serverVersion = await api.detectServerVersion();

  const myTeams = await api.getMyTeams();
  const myTeamIds = new Set(myTeams.map((team) => team.id));

  // Le compte doit etre membre d une team pour lister ses canaux publics. On
  // signale celles qui manquent sans jamais les rejoindre : le join de team est
  // une ecriture, il exige --join-teams et un consentement explicite.
  let allTeams: MmTeam[] = myTeams;
  try {
    allTeams = await api.getAllTeams();
  } catch {
    // GET /teams demande une permission que tous les comptes n ont pas. Sans
    // lui on ne sait pas ce qui manque, ce qui n empeche pas d inventorier le
    // reste.
    warnings.push({
      code: "TEAM_NOT_MEMBER",
      detail:
        "Impossible de lister toutes les teams de l instance : la completude de l inventaire ne peut pas etre verifiee.",
    });
  }

  const teamsNotJoined = allTeams.filter((team) => !myTeamIds.has(team.id) && team.delete_at === 0);
  for (const team of teamsNotJoined) {
    warnings.push({
      code: "TEAM_NOT_MEMBER",
      team_id: team.id,
      detail: `Le compte n est pas membre de la team "${team.name}" : ses canaux publics sont invisibles. Rejoindre une team est une ecriture, elle exige --join-teams.`,
    });
  }

  const selectionTeams: SelectionTeam[] = [];
  let teamIndex = 0;

  for (const team of myTeams) {
    teamIndex += 1;
    options.onProgress?.({
      phase: "teams",
      label: team.display_name || team.name,
      done: teamIndex,
      total: myTeams.length,
    });

    const [joinedChannels, publicChannels, archivedChannels] = await Promise.all([
      api.getMyChannelsForTeam(team.id),
      api.getPublicChannelsForTeam(team.id),
      api.getDeletedChannelsForTeam(team.id),
    ]);

    const joinedIds = new Set(joinedChannels.map((channel) => channel.id));
    const byId = new Map<string, MmChannel>();
    // Filtre defensif a chaque etage : quelle que soit la provenance, seul un
    // canal de type "O" peut entrer dans la selection.
    for (const channel of [...publicChannels, ...archivedChannels, ...joinedChannels]) {
      if (!isPublicChannel(channel)) {
        warnings.push({
          code: "NON_PUBLIC_CHANNEL_REJECTED",
          channel_id: channel.id,
          detail: `Canal de type "${channel.type}" ecarte de l inventaire.`,
        });
        continue;
      }
      byId.set(channel.id, channel);
    }

    const channels: SelectionChannel[] = [];
    const ordered = [...byId.values()].sort((a, b) =>
      a.display_name.localeCompare(b.display_name, "fr"),
    );

    let probed = 0;
    for (const channel of ordered) {
      const joined = joinedIds.has(channel.id);
      const archived = isArchivedChannel(channel);

      let readable: boolean | undefined;
      if (!joined && (archived || probeUnjoined)) {
        probed += 1;
        options.onProgress?.({
          phase: "probe",
          label: channel.display_name || channel.name,
          done: probed,
          total: ordered.length,
        });
        readable = await api.probeChannelReadable(channel.id);
        if (archived && !readable) {
          warnings.push({
            code: "ARCHIVED_CHANNEL_FORBIDDEN",
            channel_id: channel.id,
            detail: `Canal archive "${channel.name}" illisible : ViewArchivedChannels est probablement desactive sur le serveur.`,
          });
        }
      }

      channels.push(toSelectionChannel(channel, { joined, archived, readable }));
    }

    selectionTeams.push({
      id: team.id,
      name: team.name,
      display_name: team.display_name,
      joined: true,
      channels,
    });
  }

  const file: SelectionFile = {
    meta: {
      generated_at: clock(),
      tool_version: options.toolVersion,
      source_url: options.sourceUrl,
      account: {
        user_id: account.id,
        username: account.username,
        is_system_admin: isSystemAdmin(account),
      },
    },
    teams: selectionTeams,
  };

  return {
    file,
    summary: summarizeSelection(file),
    warnings,
    teamsNotJoined,
    account,
    serverVersion,
  };
}
