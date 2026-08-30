import { describeError } from "@mmarchive/shared";
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
// Commander sort en 0 quand une option requise manque, ce qui ferait croire a un
// script que la commande a fait son travail. Le README documente 2 pour un
// argument invalide, et c est ce que rendent les autres commandes.
program.exitOverride((erreur) => {
  if (erreur.code === "commander.helpDisplayed" || erreur.code === "commander.version") {
    process.exit(0);
  }
  process.stderr.write(erreur.message.endsWith("\n") ? erreur.message : `${erreur.message}\n`);
  process.exit(erreur.code === "commander.missingMandatoryOptionValue" ? 2 : 1);
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
  new Logger().error(describeError(error));
  // Une saisie fautive et une panne ne se traitent pas pareil dans un script :
  // la premiere se corrige et se relance, la seconde s enquete. Le README
  // documente 2 pour un argument invalide, ce qu est un identifiant malforme
  // comme un chemin qui ne designe pas une archive.
  process.exitCode = error instanceof ArchivePathError ? 2 : 1;
}
