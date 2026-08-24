import {
  categorizeChannel,
  summarizeSelection,
  type SelectionFile,
  type SelectionSummary,
} from "@mmarchive/shared";

/**
 * Applique un ensemble d identifiants coches au fichier de selection.
 *
 * Separee du TUI pour rester testable : c est ici que se decide ce qui sera
 * extrait, donc ce qui declenchera des messages systeme sur l instance.
 */
export function applySelection(
  file: SelectionFile,
  selectedIds: ReadonlySet<string>,
): SelectionFile {
  return {
    meta: file.meta,
    teams: file.teams.map((team) => ({
      ...team,
      channels: team.channels.map((channel) => {
        // Un canal archive illisible ne peut pas etre extrait : le cocher n a
        // aucun effet utile et donnerait une fausse impression de completude.
        const selectable = categorizeChannel(channel) !== "archived_unreadable";
        return { ...channel, selected: selectable && selectedIds.has(channel.id) };
      }),
    })),
  };
}

export function currentlySelectedIds(file: SelectionFile): Set<string> {
  const ids = new Set<string>();
  for (const team of file.teams) {
    for (const channel of team.channels) {
      if (channel.selected) ids.add(channel.id);
    }
  }
  return ids;
}

export function summaryOf(file: SelectionFile): SelectionSummary {
  return summarizeSelection(file);
}
