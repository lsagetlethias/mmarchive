import {
  assertPublicChannel,
  categorizeChannel,
  ERROR_CODES,
  type ErrorCode,
  type SelectionChannel,
  type SelectionFile,
  type SelectionSummary,
  summarizeSelection,
} from "@mmarchive/shared";

export interface PlannedChannel {
  readonly channel: SelectionChannel;
  readonly teamId: string;
  readonly teamName: string;
  /** true si l extraction de ce canal exige de le rejoindre. */
  readonly requiresJoin: boolean;
}

export interface SkippedChannel {
  readonly channel: SelectionChannel;
  readonly teamId: string;
  readonly reason: "archived_unreadable";
}

export interface ExtractionPlan {
  readonly channels: readonly PlannedChannel[];
  readonly joins: readonly PlannedChannel[];
  /** Teams non rejointes contenant au moins un canal selectionne. */
  readonly teamsToJoin: readonly string[];
  readonly skipped: readonly SkippedChannel[];
  readonly summary: SelectionSummary;
}

export class SelectionMismatchError extends Error {
  readonly code: ErrorCode = ERROR_CODES.SelectionMismatchError;
  constructor(expectedUrl: string, fileUrl: string) {
    super(
      `Le fichier de selection a ete genere depuis ${fileUrl}, mais la cible est ${expectedUrl}.\n` +
        `Refus : appliquer une selection a une autre instance rejoindrait des canaux au hasard.\n` +
        `Regenerer le fichier avec: mmarchive-extract inventory --url ${expectedUrl}`,
    );
    this.name = "SelectionMismatchError";
  }
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/**
 * Garde-fou d identite : un channels.yaml genere pour une instance ne doit
 * jamais etre applique a une autre. Les identifiants de canaux n auraient aucun
 * sens sur la cible, et le run pourrait rejoindre des canaux arbitraires.
 */
export function assertSelectionMatchesTarget(file: SelectionFile, targetUrl: string): void {
  if (normalize(file.meta.source_url) !== normalize(targetUrl)) {
    throw new SelectionMismatchError(targetUrl, file.meta.source_url);
  }
}

/**
 * Traduit une selection en plan d execution.
 *
 * C est le seul endroit qui decide quels canaux seront rejoints. Un canal qui
 * n est pas selected: true n apparait jamais dans plan.joins, quel que soit son
 * etat par ailleurs.
 */
export function buildPlan(file: SelectionFile): ExtractionPlan {
  const channels: PlannedChannel[] = [];
  const joins: PlannedChannel[] = [];
  const skipped: SkippedChannel[] = [];
  const teamsToJoin = new Set<string>();

  for (const team of file.teams) {
    for (const channel of team.channels) {
      if (!channel.selected) continue;

      // Filtre defensif : le YAML est editable a la main, c est le chemin le
      // plus plausible pour tenter de faire entrer un canal non public.
      assertPublicChannel(channel);

      const category = categorizeChannel(channel);
      if (category === "archived_unreadable") {
        skipped.push({ channel, teamId: team.id, reason: "archived_unreadable" });
        continue;
      }

      const planned: PlannedChannel = {
        channel,
        teamId: team.id,
        teamName: team.display_name || team.name,
        requiresJoin: category === "join_required",
      };
      channels.push(planned);
      if (planned.requiresJoin) {
        joins.push(planned);
        if (!team.joined) teamsToJoin.add(team.id);
      }
    }
  }

  return {
    channels,
    joins,
    teamsToJoin: [...teamsToJoin],
    skipped,
    summary: summarizeSelection(file),
  };
}

/**
 * Restreint une selection aux canaux deja accessibles. C est le mode par defaut
 * du run sans --file : il ne peut, par construction, induire aucun join.
 */
export function restrictToAccessible(file: SelectionFile): SelectionFile {
  return {
    meta: file.meta,
    teams: file.teams.map((team) => ({
      ...team,
      channels: team.channels.map((channel) => {
        const category = categorizeChannel(channel);
        const accessible = category === "member" || category === "readable_without_join";
        return { ...channel, selected: accessible };
      }),
    })),
  };
}
