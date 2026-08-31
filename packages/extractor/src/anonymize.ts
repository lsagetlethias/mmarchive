import { type ArchiveUser, describeError } from "@mmarchive/shared";
import { readNdjson } from "@mmarchive/shared/ndjson";
import { Command } from "commander";
import { ArchivePathError, createArchivePaths } from "./archive/paths.js";
import { AnonymizeError, anonymizeArchive } from "./redact/anonymize-archive.js";
import {
  checkResidualIdentities,
  collecterIdentitesOrigine,
  ResidualIdentityError,
} from "./redact/residual-check.js";
import { Logger } from "./ui/logger.js";
import { TOOL_VERSION } from "./version.js";

/**
 * Commande distincte de `mmarchive-redact`, et non un drapeau de celle-ci.
 *
 * Les deux operations n ont en commun que leur mecanique. L une honore la
 * demande d une personne et laisse l archive intacte par ailleurs ; l autre
 * reecrit tout et prepare une diffusion. Sous un meme verbe, un drapeau oublie
 * ou ajoute par erreur transformerait l une en l autre. Deux noms rendent la
 * confusion impossible a commettre plutot que rare.
 */
const program = new Command();

const SORTIES_NORMALES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
]);
program.exitOverride((erreur) => {
  process.exit(SORTIES_NORMALES.has(erreur.code) ? 0 : 2);
});

program
  .name("mmarchive-anonymize")
  .description(
    "Produit une copie anonymisee d une archive, en vue de sa diffusion. L archive source n est jamais modifiee.",
  )
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .requiredOption("--archive <dir>", "Repertoire de l archive a lire")
  .requiredOption("--out <dir>", "Repertoire de l archive anonymisee a produire")
  .option("--force", "Ecrit dans un repertoire de sortie qui n est pas vide")
  .option("--skip-check", "Saute le controle des identites residuelles. Deconseille.")
  .action(async (opts: { archive: string; out: string; force?: boolean; skipCheck?: boolean }) => {
    const logger = new Logger();

    const result = await anonymizeArchive({
      archiveDir: opts.archive,
      outDir: opts.out,
      force: opts.force ?? false,
      logger,
    });

    logger.info(
      `${String(result.referencesReecrites)} references d identite reecrites, ` +
        `${String(result.props.referencesReecrites)} dans props, ` +
        `${String(result.props.referencesOrphelines)} retirees faute de compte correspondant.`,
    );
    logger.info(
      `props : ${String(result.props.clesRetirees)} cles retirees, ` +
        `${String(result.props.attachmentsReduits)} blocs attachments reduits a leur texte.`,
    );

    if (opts.skipCheck === true) {
      logger.warn(
        "Controle des identites residuelles saute. Rien ne garantit ce que l archive contient encore.",
      );
    } else {
      await controler(opts.archive, opts.out, logger);
    }

    // Le dire a la fin, apres les chiffres, parce que c est ce qu on retient.
    logger.warn(
      "Cette passe n a pas touche au corps des messages : mentions, noms en clair et adresses y survivent.",
    );
    logger.warn("L archive produite n est pas encore diffusable.");
  });

async function controler(archiveDir: string, outDir: string, logger: Logger): Promise<void> {
  logger.info("Controle des identites residuelles.");
  const source = createArchivePaths(archiveDir);
  const sortie = createArchivePaths(outDir);

  const originaux: ArchiveUser[] = [];
  for await (const user of readNdjson<ArchiveUser>(source.users)) originaux.push(user);
  const origine = collecterIdentitesOrigine(originaux);

  const uids = new Set<string>();
  const usernames = new Set<string>();
  for await (const user of readNdjson<ArchiveUser>(sortie.users)) {
    uids.add(user.id);
    usernames.add(user.username);
  }

  const rapport = await checkResidualIdentities({
    outDir,
    origine,
    substitution: { uids, usernames },
  });

  if (rapport.manquements.length > 0) {
    for (const manquement of rapport.manquements.slice(0, 20)) {
      logger.error(
        `${manquement.emplacement} ${manquement.champ} [${manquement.genre}] : ${manquement.extrait}`,
      );
    }
    const reste = rapport.manquements.length - 20;
    if (reste > 0) logger.error(`et ${String(reste)} autre(s).`);
    throw new ResidualIdentityError(
      `${String(rapport.manquements.length)} identite(s) ont survecu a l anonymisation. ` +
        "L archive produite ne doit pas etre diffusee.",
    );
  }

  logger.info(
    `Controle passe : ${String(rapport.referencesVerifiees)} references et ` +
      `${String(rapport.valeursVerifiees)} valeurs verifiees.`,
  );
  logger.warn("Ce controle ne couvre pas :");
  for (const limite of rapport.horsControle) logger.warn(`  - ${limite}`);
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  new Logger().error(describeError(error));
  // Une saisie fautive se corrige et se relance ; une identite qui survit est
  // une panne de l outil, et l archive produite ne doit pas partir.
  process.exitCode = error instanceof ArchivePathError || error instanceof AnonymizeError ? 2 : 1;
}
