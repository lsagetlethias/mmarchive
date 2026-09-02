import { resolve } from "node:path";
import { categorizeChannel } from "@mmarchive/shared";
import { type RawOptions, resolveConnection } from "../config/options.js";
import { createContext } from "../context.js";
import { buildInventory } from "../inventory/build-inventory.js";
import { writeSelectionFile } from "../inventory/yaml-file.js";
import { Logger } from "../ui/logger.js";
import { TOOL_VERSION } from "../version.js";

export interface InventoryCommandOptions extends RawOptions {
  readonly probe?: boolean | undefined;
  readonly selectArchived?: boolean | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Inventorie les canaux publics visibles sans rien modifier sur l instance.
 * Aucune requete d ecriture n est emise par cette commande, quel que soit le
 * contenu rencontre.
 */
export async function inventoryCommand(
  raw: InventoryCommandOptions,
  env: Record<string, string | undefined>,
  logger = new Logger(),
): Promise<void> {
  const connection = resolveConnection(raw, env);
  const outPath = resolve(raw.out ?? "./channels.yaml");
  const { api } = createContext(connection, { rateLimit: 8, logger });

  logger.section("Inventaire des canaux publics");
  logger.info(`Instance : ${connection.url}`);

  const result = await buildInventory({
    api,
    toolVersion: TOOL_VERSION,
    sourceUrl: connection.url,
    probeUnjoined: raw.probe ?? true,
    selectArchived: raw.selectArchived ?? false,
    onProgress: (progress) => {
      if (progress.phase === "teams") {
        logger.info(`Team ${String(progress.done)}/${String(progress.total)} : ${progress.label}`);
      }
    },
  });

  const account = result.account;
  const role = result.file.meta.account.is_system_admin ? "system_admin" : "compte standard";
  logger.info(`Compte : ${account.username} (${role})`);
  logger.info(`Version du serveur : ${result.serverVersion}`);

  const summary = result.summary;
  const counts = new Map<string, number>();
  for (const team of result.file.teams) {
    for (const channel of team.channels) {
      const category = categorizeChannel(channel);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  logger.section("Resultat");
  logger.table(
    ["Categorie", "Canaux"],
    [
      ["Deja membre", String(counts.get("member") ?? 0)],
      ["Lisible sans rejoindre", String(counts.get("readable_without_join") ?? 0)],
      ["Join requis", String(counts.get("join_required") ?? 0)],
      ["Archive, lisible", String(counts.get("archived_readable") ?? 0)],
      ["Archive, illisible", String(counts.get("archived_unreadable") ?? 0)],
      ["Total", String(summary.channelsTotal)],
    ],
  );

  for (const warning of result.warnings) {
    logger.warn(`${warning.code} : ${warning.detail}`);
  }

  await writeSelectionFile(outPath, result.file, summary);

  logger.success(`Fichier de selection ecrit : ${outPath}`);

  if (raw.json === true) {
    // Les cinq categories que rend `categorizeChannel`, telles quelles : c est
    // sur elles que se decide ce qu il faudra cocher, et un script qui les
    // recompterait depuis le YAML dupliquerait cette logique. Le tableau
    // affiche plus haut en montre les memes, la table du CLAUDE.md n en
    // distingue que quatre parce qu elle ne separe pas les canaux archives
    // selon leur lisibilite.
    process.stdout.write(
      `${JSON.stringify(
        {
          instance: connection.url,
          compte: {
            username: account.username,
            is_system_admin: result.file.meta.account.is_system_admin,
          },
          serveur: result.serverVersion,
          categories: {
            member: counts.get("member") ?? 0,
            readable_without_join: counts.get("readable_without_join") ?? 0,
            join_required: counts.get("join_required") ?? 0,
            archived_readable: counts.get("archived_readable") ?? 0,
            archived_unreadable: counts.get("archived_unreadable") ?? 0,
          },
          channels_total: summary.channelsTotal,
          channels_preselected: summary.channelsSelected,
          selection_file: outPath,
          warnings: result.warnings.map((warning) => ({
            code: warning.code,
            detail: warning.detail,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  logger.callout("Aucune modification n a ete faite sur l instance", [
    "Cette commande n emet que des lectures.",
    `${String(summary.channelsSelected)} canaux sont pre-selectionnes, tous deja accessibles.`,
    "Les canaux necessitant un join restent decoches : c est a vous de les choisir.",
    "",
    "Etape suivante :",
    `  mmarchive-extract select --file ${outPath}`,
  ]);
}
