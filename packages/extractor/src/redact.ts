import { Command } from "commander";
import { type RedactMode, redactArchive } from "./redact/redact-archive.js";
import { Logger } from "./ui/logger.js";
import { TOOL_VERSION } from "./version.js";

/**
 * Point d entree du binaire. La logique vit dans redact/redact-archive.ts :
 * analyser process.argv au chargement du module rendait la commande
 * impossible a tester, l import suffisant a terminer le processus.
 */
const program = new Command();
program
  .name("mmarchive-redact")
  .description("Honore une demande d effacement sur une archive deja produite.")
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .requiredOption("--archive <dir>", "Repertoire de l archive")
  .requiredOption("--user <user_id>", "Identifiant de l utilisateur concerne")
  .requiredOption("--mode <mode>", "remove ou pseudonymize")
  .action(async (opts: { archive: string; user: string; mode: string }) => {
    const logger = new Logger();
    if (opts.mode !== "remove" && opts.mode !== "pseudonymize") {
      logger.error(`--mode doit valoir "remove" ou "pseudonymize", recu "${opts.mode}".`);
      process.exitCode = 2;
      return;
    }
    await redactArchive({
      archiveDir: opts.archive,
      userId: opts.user,
      mode: opts.mode as RedactMode,
      logger,
    });
    logger.warn("Une reindexation du viewer est necessaire apres cette operation.");
  });

await program.parseAsync(process.argv);
