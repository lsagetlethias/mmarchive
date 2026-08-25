import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { categorizeChannel, type SelectionChannel, type SelectionFile } from "@mmarchive/shared";
import { applySelection, currentlySelectedIds, summaryOf } from "../inventory/apply-selection.js";
import { readSelectionFile, writeSelectionFile } from "../inventory/yaml-file.js";
import { isInteractive } from "../ui/environment.js";
import { Logger } from "../ui/logger.js";

export class SelectionCancelled extends Error {
  constructor(detail = "Selection annulee, le fichier n a pas ete modifie.") {
    super(detail);
    this.name = "SelectionCancelled";
  }
}

function label(channel: SelectionChannel): string {
  const count = channel.message_count.toLocaleString("fr-FR");
  return `${channel.display_name || channel.name} (${count} messages)`;
}

/**
 * Selection interactive des canaux a extraire.
 *
 * Les canaux sans effet de bord et ceux qui exigent un join sont presentes dans
 * deux etapes DISTINCTES : melanger les deux listes rendrait trop facile de
 * cocher par inadvertance un canal dont l ajout publie un message systeme.
 */
export async function selectCommand(
  filePath: string,
  logger = new Logger(),
): Promise<SelectionFile> {
  // Cette commande est interactive par nature : la lancer sans terminal
  // suspendrait le processus a la premiere question.
  if (!isInteractive()) {
    throw new SelectionCancelled(
      "Aucun terminal interactif. Editez directement le fichier de selection, " +
        "le champ selected de chaque canal, puis lancez run.",
    );
  }

  const path = resolve(filePath);
  const file = await readSelectionFile(path);
  const alreadySelected = currentlySelectedIds(file);
  const chosen = new Set<string>();

  prompts.intro("mmarchive - selection des canaux a archiver");

  for (const team of file.teams) {
    const free: SelectionChannel[] = [];
    const joinRequired: SelectionChannel[] = [];
    const archivedReadable: SelectionChannel[] = [];
    let unreadable = 0;

    for (const channel of team.channels) {
      switch (categorizeChannel(channel)) {
        case "member":
        case "readable_without_join":
          free.push(channel);
          break;
        case "join_required":
          joinRequired.push(channel);
          break;
        case "archived_readable":
          archivedReadable.push(channel);
          break;
        case "archived_unreadable":
          unreadable += 1;
          break;
      }
    }

    const teamName = team.display_name || team.name;

    if (free.length > 0 || archivedReadable.length > 0) {
      // exactOptionalPropertyTypes interdit hint: undefined, il faut omettre la cle.
      const options = [...free, ...archivedReadable].map((channel) => ({
        value: channel.id,
        label: label(channel),
        ...(channel.archived ? { hint: "archive" } : {}),
      }));
      const answer = await prompts.multiselect({
        message: `${teamName} - canaux accessibles, aucun effet de bord`,
        options,
        initialValues: options.filter((o) => alreadySelected.has(o.value)).map((o) => o.value),
        required: false,
      });
      if (prompts.isCancel(answer)) throw new SelectionCancelled();
      for (const id of answer) chosen.add(id);
    }

    if (joinRequired.length > 0) {
      prompts.log.warn(
        `${teamName} : ${String(joinRequired.length)} canaux exigent de REJOINDRE le canal.\n` +
          `Chaque canal coche ici publiera un message systeme visible par tous ses membres.`,
      );
      const options = joinRequired.map((channel) => ({
        value: channel.id,
        label: label(channel),
        hint: "publiera un message systeme",
      }));
      const answer = await prompts.multiselect({
        message: `${teamName} - canaux a REJOINDRE (decoches par defaut)`,
        options,
        initialValues: options.filter((o) => alreadySelected.has(o.value)).map((o) => o.value),
        required: false,
      });
      if (prompts.isCancel(answer)) throw new SelectionCancelled();
      for (const id of answer) chosen.add(id);
    }

    if (unreadable > 0) {
      prompts.log.info(
        `${teamName} : ${String(unreadable)} canal(aux) archive(s) illisible(s), non selectionnables.`,
      );
    }
  }

  const updated = applySelection(file, chosen);
  const summary = summaryOf(updated);

  prompts.note(
    [
      `${String(summary.channelsSelected)} canaux selectionnes sur ${String(summary.channelsTotal)}`,
      `environ ${summary.estimatedMessages.toLocaleString("fr-FR")} messages`,
      summary.joinsInduced === 0
        ? "aucun message systeme ne sera publie"
        : `${String(summary.joinsInduced)} message(s) systeme seront publies sur l instance`,
    ].join("\n"),
    "Recapitulatif",
  );

  if (summary.joinsInduced > 0) {
    const confirmed = await prompts.confirm({
      message: `Confirmer ${String(summary.joinsInduced)} join(s) ? Les canaux concernes : ${summary.channelsRequiringJoin
        .map((c) => c.name)
        .join(", ")}`,
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || !confirmed) throw new SelectionCancelled();
  }

  await writeSelectionFile(path, updated, summary);
  prompts.outro(`Selection enregistree dans ${path}`);
  logger.debug(`Selection ecrite : ${String(summary.channelsSelected)} canaux.`);
  return updated;
}
