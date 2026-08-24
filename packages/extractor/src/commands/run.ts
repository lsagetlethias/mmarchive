import { writeFile } from "node:fs/promises";
import * as prompts from "@clack/prompts";
import type { Manifest, SelectionFile, SelectionMode } from "@mmarchive/shared";
import { createArchivePaths } from "../archive/paths.js";
import { parseRunOptions, rateLimitNotice, type RawOptions } from "../config/options.js";
import { createContext } from "../context.js";
import { buildInventory } from "../inventory/build-inventory.js";
import { readSelectionFile } from "../inventory/yaml-file.js";
import {
  assertSelectionMatchesTarget,
  restrictToAccessible,
  type ExtractionPlan,
} from "../extract/plan.js";
import { runExtraction } from "../extract/orchestrator.js";
import { Logger } from "../ui/logger.js";
import { TOOL_VERSION } from "../version.js";

/**
 * Affiche la liste NOMINATIVE des canaux a rejoindre et demande une
 * confirmation. C est le dernier point d arret avant que l outil ne publie quoi
 * que ce soit sur l instance.
 */
async function confirmJoinsInteractively(
  plan: ExtractionPlan,
  logger: Logger,
  autoYes: boolean,
): Promise<boolean> {
  logger.callout(`${String(plan.joins.length)} canaux vont etre REJOINTS`, [
    "Rejoindre un canal publie un message systeme visible par tous ses membres.",
    `Cette operation publiera ${String(plan.joins.length)} message(s) systeme.`,
    "",
    "Canaux concernes :",
    ...plan.joins.map((join) => `  - ${join.teamName} / ${join.channel.name}`),
  ]);

  if (autoYes) {
    logger.warn("--yes : confirmation court-circuitee.");
    return true;
  }

  const answer = await prompts.confirm({
    message: `Publier ${String(plan.joins.length)} message(s) systeme et rejoindre ces canaux ?`,
    initialValue: false,
  });
  return !prompts.isCancel(answer) && answer;
}

export async function runCommand(
  raw: RawOptions,
  env: Record<string, string | undefined>,
  logger = new Logger(),
): Promise<Manifest> {
  const options = parseRunOptions(raw, env);
  const notice = rateLimitNotice(options.rateLimit);
  if (notice !== undefined) logger.warn(notice);

  const { api, client } = createContext(options.connection, {
    rateLimit: options.rateLimit,
    logger,
  });

  logger.section("Extraction");
  logger.info(`Instance : ${options.connection.url}`);

  const account = await api.getMe();
  let selection: SelectionFile;
  let mode: SelectionMode;
  let totalPublicChannels: number;

  if (options.file === undefined) {
    // Mode sur par defaut : on inventorie sans sonder les canaux non rejoints,
    // puis on ne retient que ce qui est deja accessible. Aucun join possible.
    logger.info("Aucun fichier de selection : mode sur, canaux deja accessibles uniquement.");
    const inventory = await buildInventory({
      api,
      toolVersion: TOOL_VERSION,
      sourceUrl: options.connection.url,
      probeUnjoined: false,
    });
    selection = restrictToAccessible(inventory.file);
    mode = "accessible";
    totalPublicChannels = inventory.summary.channelsTotal;
  } else {
    selection = await readSelectionFile(options.file);
    assertSelectionMatchesTarget(selection, options.connection.url);
    mode = "file";
    totalPublicChannels = selection.teams.reduce((sum, team) => sum + team.channels.length, 0);
  }

  const manifest = await runExtraction({
    api,
    client,
    account,
    runOptions: options,
    selection,
    selectionMode: mode,
    totalPublicChannels,
    logger,
    confirmJoins: (plan) => confirmJoinsInteractively(plan, logger, options.yes),
  });

  const paths = createArchivePaths(options.out);
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  logger.section("Termine");
  logger.table(
    ["Element", "Nombre"],
    [
      ["Canaux", String(manifest.counts.channels)],
      ["Messages", manifest.counts.posts.toLocaleString("fr-FR")],
      ["Utilisateurs", String(manifest.counts.users)],
      ["Pieces jointes", String(manifest.counts.attachments)],
      ["Canaux rejoints par l outil", String(manifest.selection.channels_joined_by_tool)],
      ["Avertissements", String(manifest.warnings.length)],
    ],
  );
  logger.success(`Archive ecrite dans ${paths.root}`);

  if (manifest.selection.channels_joined_by_tool > 0 && !options.leaveAfter) {
    logger.warn(
      "Les canaux rejoints n ont pas ete quittes (--leave-after est a false). " +
        "Partir publierait un second message systeme dans chacun.",
    );
  }
  return manifest;
}
