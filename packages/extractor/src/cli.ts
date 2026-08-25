import { Command } from "commander";
import { inventoryCommand } from "./commands/inventory.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";
import { selectCommand } from "./commands/select.js";
import { verifyCommand } from "./commands/verify.js";
import { OptionsError } from "./config/options.js";
import { Logger } from "./ui/logger.js";
import { TOOL_VERSION } from "./version.js";

const logger = new Logger();

const program = new Command();
program
  .name("mmarchive-extract")
  .description(
    "Archive les canaux publics d une instance Mattermost vers un format ouvert et durable.",
  )
  .version(TOOL_VERSION);

program
  .command("inventory")
  .description("Inventorie les canaux publics visibles. N ecrit rien sur l instance.")
  .option("--url <url>", "URL de l instance (ou MM_URL)")
  .option("--token <token>", "Token porteur (ou MM_TOKEN)")
  .option("--out <file>", "Fichier de selection a produire", "./channels.yaml")
  .option(
    "--select-archived",
    "Pre-coche aussi les canaux archives lisibles. Ils ne coutent aucun join, mais disparaitront avec l instance.",
  )
  .option(
    "--no-probe",
    "Ne sonde pas les canaux non rejoints. Plus rapide, mais un compte capable de les lire sans join ne sera pas detecte.",
  )
  .action(async (opts: Record<string, unknown>) => {
    await inventoryCommand(opts, process.env, logger);
  });

program
  .command("doctor")
  .description(
    "Mesure le debit autorise et la taille de page acceptee, pour calibrer un long run. N ecrit rien.",
  )
  .option("--url <url>", "URL de l instance (ou MM_URL)")
  .option("--token <token>", "Token porteur (ou MM_TOKEN)")
  .option("--file <yaml>", "Fichier de selection, pour estimer le run et choisir un canal temoin")
  .action(async (opts: Record<string, unknown>) => {
    await doctorCommand(opts, process.env, logger);
  });

program
  .command("select")
  .description("Selection interactive des canaux a extraire. Reecrit le fichier.")
  .requiredOption("--file <yaml>", "Fichier de selection")
  .action(async (opts: { file: string }) => {
    await selectCommand(opts.file, logger);
  });

program
  .command("run")
  .description("Extrait les canaux selectionnes vers une archive.")
  .option("--url <url>", "URL de l instance (ou MM_URL)")
  .option("--token <token>", "Token porteur (ou MM_TOKEN)")
  .option("--file <yaml>", "Fichier de selection. Sans lui : canaux deja accessibles uniquement.")
  .option("--out <dir>", "Repertoire de sortie", "./archive")
  .option("--yes", "Pas de confirmation interactive des joins")
  .option("--join-teams", "Autorise a rejoindre les teams manquantes")
  .option("--leave-after", "Quitte les canaux rejoints en fin de run")
  .option("--since <iso>", "Extraction incrementale depuis une date ISO 8601")
  .option("--resume", "Reprend depuis le fichier d etat")
  .option("--skip-files", "N extrait pas les pieces jointes")
  .option("--max-file-size <mb>", "Ignore les fichiers au dessus, en Mo", "100")
  .option("--include-emails", "Inclut les adresses e-mail des utilisateurs")
  .option("--concurrency <n>", "Canaux traites en parallele", "4")
  .option("--rate-limit <n>", "Requetes par seconde", "8")
  .option(
    "--posts-page-size <n>",
    "Messages demandes par requete. 200 par defaut ; mesurer la valeur acceptee avec la sous-commande doctor.",
    "200",
  )
  .action(async (opts: Record<string, unknown>) => {
    await runCommand(opts, process.env, logger);
  });

program
  .command("verify")
  .description("Verifie une archive deja produite. Lecture seule, aucune connexion reseau.")
  .option("--archive <dir>", "Repertoire de l archive", "./archive")
  .option("--no-blobs", "Ne verifie pas la presence sur disque de chaque piece jointe")
  .action(async (opts: Record<string, unknown>) => {
    const errors = await verifyCommand(opts, logger);
    // Code de sortie exploitable depuis un script de sauvegarde.
    if (errors > 0) process.exitCode = 1;
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof OptionsError) {
      logger.error(error.message);
      process.exitCode = 2;
      return;
    }
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
