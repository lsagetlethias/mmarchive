import { codeDeSortieCommander, describeFailure } from "@mmarchive/shared";
import { Command } from "commander";
import { ArchivePathError } from "./archive/paths.js";
import { type RedactMode, redactArchive } from "./redact/redact-archive.js";
import { Logger } from "./ui/logger.js";
import { TOOL_VERSION } from "./version.js";

/**
 * Point d entree du binaire. La logique vit dans redact/redact-archive.ts :
 * analyser process.argv au chargement du module rendait la commande
 * impossible a tester, l import suffisant a terminer le processus.
 */
const program = new Command();
program.exitOverride((erreur) => {
  process.exit(codeDeSortieCommander(erreur.code));
});
program
  .name("mmarchive-redact")
  .description("Honore une demande d effacement sur une archive deja produite.")
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .requiredOption("--archive <dir>", "Repertoire de l archive")
  .requiredOption("--user <user_id>", "Identifiant de l utilisateur concerne")
  .requiredOption("--mode <mode>", "remove ou pseudonymize")
  .option(
    "--dry-run",
    "Annonce ce qui serait efface, sans rien modifier. L operation est irreversible : la simulation est le seul moyen de la relire avant.",
  )
  .action(async (opts: { archive: string; user: string; mode: string; dryRun?: boolean }) => {
    const logger = new Logger();
    if (opts.mode !== "remove" && opts.mode !== "pseudonymize") {
      logger.error(`--mode doit valoir "remove" ou "pseudonymize", recu "${opts.mode}".`);
      process.exitCode = 2;
      return;
    }
    const result = await redactArchive({
      archiveDir: opts.archive,
      userId: opts.user,
      mode: opts.mode as RedactMode,
      dryRun: opts.dryRun ?? false,
      logger,
    });
    if (result.dryRun) {
      logger.info("Relancez sans --dry-run pour appliquer.");
      return;
    }
    logger.warn("Une reindexation du viewer est necessaire apres cette operation.");
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  new Logger().error(describeFailure(error, TOOL_VERSION));
  // Une saisie fautive et une panne ne se traitent pas pareil dans un script :
  // la premiere se corrige et se relance, la seconde s enquete. Le README
  // documente 2 pour un argument invalide, ce qu est un identifiant malforme
  // comme un chemin qui ne designe pas une archive.
  process.exitCode = error instanceof ArchivePathError ? 2 : 1;
}
