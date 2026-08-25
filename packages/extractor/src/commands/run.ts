import { writeFile } from "node:fs/promises";
import * as prompts from "@clack/prompts";
import type { Manifest, SelectionFile, SelectionMode } from "@mmarchive/shared";
import { createArchivePaths } from "../archive/paths.js";
import { parseRunOptions, type RawOptions, rateLimitNotice } from "../config/options.js";
import { createContext } from "../context.js";
import { runExtraction } from "../extract/orchestrator.js";
import {
  assertSelectionMatchesTarget,
  type ExtractionPlan,
  restrictToAccessible,
} from "../extract/plan.js";
import { buildInventory } from "../inventory/build-inventory.js";
import { readSelectionFile } from "../inventory/yaml-file.js";
import { isInteractive } from "../ui/environment.js";
import { Logger } from "../ui/logger.js";
import { RunReporter } from "../ui/run-reporter.js";
import { verifyArchive } from "../verify/checks.js";
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

  // Hors terminal, personne ne repondra jamais : mieux vaut refuser avec un
  // message exploitable que suspendre un run d integration continue.
  if (!isInteractive()) {
    logger.error(
      "Des joins sont necessaires mais aucun terminal interactif n est disponible pour les confirmer. " +
        "Relancez avec --yes si vous assumez la publication de ces messages systeme, " +
        "ou retirez ces canaux de la selection.",
    );
    return false;
  }

  const answer = await prompts.confirm({
    message: `Publier ${String(plan.joins.length)} message(s) systeme et rejoindre ces canaux ?`,
    initialValue: false,
  });
  return !prompts.isCancel(answer) && answer;
}

export interface RunCommandResult {
  readonly manifest: Manifest;
  /** Controles de coherence en echec. Non nul, l archive n est pas fiable. */
  readonly verificationErrors: number;
}

export async function runCommand(
  raw: RawOptions & { verify?: boolean | undefined },
  env: Record<string, string | undefined>,
  logger = new Logger(),
): Promise<RunCommandResult> {
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
      ["Emojis personnalises", String(manifest.counts.emojis)],
      ["Pieces jointes", String(manifest.counts.attachments)],
      ["Volume des pieces jointes", `${(manifest.counts.attachments_bytes / 1e9).toFixed(2)} Go`],
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

  /**
   * Verification immediate de l archive produite.
   *
   * Une extraction assemblee en plusieurs sessions peut etre incoherente avec
   * elle-meme sans que rien ne le signale sur le moment. Detecter l ecart des
   * la fin du run, plutot que des heures ou des jours plus tard, est la
   * difference entre relancer une reprise et decouvrir le probleme quand
   * l instance n existe plus.
   *
   * La presence des binaires n est pas recontrolee : ils viennent d etre
   * ecrits, et cela couterait un appel systeme par piece jointe.
   */
  if (raw.verify === false) {
    logger.warn("Verification de l archive sautee (--no-verify).");
    return { manifest, verificationErrors: 0 };
  }

  logger.section("Verification de l archive");
  const progress = new RunReporter({ estimatedMessages: 0 });
  progress.start();
  const report = await verifyArchive({
    archiveDir: paths.root,
    checkBlobs: false,
    onProgress: (step, done, total) => {
      if (total !== undefined && total > 0) {
        progress.phase(step, total);
        if (done !== undefined) progress.phaseProgress(done);
      } else {
        progress.phase(step);
      }
    },
  });
  progress.stop();

  for (const result of report.results) {
    if (result.severity === "error") {
      logger.error(`${result.label}${result.detail === undefined ? "" : ` : ${result.detail}`}`);
    } else if (result.severity === "warning") {
      logger.warn(`${result.label}${result.detail === undefined ? "" : ` : ${result.detail}`}`);
    }
  }

  if (report.errors === 0) {
    logger.success("Archive coherente.");
  } else {
    logger.error(
      `${String(report.errors)} controle(s) de coherence en echec. ` +
        "L archive n est pas fiable en l etat : relancez avec --resume, " +
        "puis inspectez le detail avec mmarchive-extract verify.",
    );
  }

  return { manifest, verificationErrors: report.errors };
}
