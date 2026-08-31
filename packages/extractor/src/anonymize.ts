import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ArchiveUser, describeError } from "@mmarchive/shared";
import { readNdjson } from "@mmarchive/shared/ndjson";
import { Command } from "commander";
import { ArchivePathError, createArchivePaths } from "./archive/paths.js";
import {
  AnonymizeError,
  type AnonymizeResult,
  anonymizeArchive,
  refuserCheminInterne,
} from "./redact/anonymize-archive.js";
import { type ContexteRapport, rendreReleve, rendreSynthese } from "./redact/report-render.js";
import {
  checkResidualIdentities,
  collecterIdentitesOrigine,
  ResidualIdentityError,
  type ResidualReport,
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

interface Options {
  archive: string;
  out: string;
  force?: boolean;
  rapport?: string;
  releve?: string;
}

program
  .name("mmarchive-anonymize")
  .description(
    "Produit une copie anonymisee d une archive, en vue de sa diffusion. L archive source n est jamais modifiee.",
  )
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .requiredOption("--archive <dir>", "Repertoire de l archive a lire")
  .requiredOption("--out <dir>", "Repertoire de l archive anonymisee a produire")
  .option(
    "--force",
    "Remplace une sortie qui porte deja une archive anonymisee. Refuse tout autre repertoire non vide.",
  )
  .option("--rapport <fichier>", "Ou ecrire la synthese. Par defaut, a cote de la sortie.")
  .option(
    "--releve <fichier>",
    "Ecrit le releve detaille des residus. Il ne se diffuse pas : il porte les formes que l anonymisation n a pas traitees.",
  )
  .action(async (opts: Options) => {
    const logger = new Logger();
    const horodatage = new Date().toISOString();
    const voisin = (nom: string): string => join(dirname(resolve(opts.out)), nom);
    const cheminSynthese = resolve(
      opts.rapport ?? voisin(`rapport-anonymisation-${horodatage}.md`),
    );
    const cheminReleve =
      opts.releve === undefined
        ? voisin(`releve-ne-pas-diffuser-${horodatage}.ndjson`)
        : resolve(opts.releve);

    // Avant la passe et non apres : un chemin fautif doit echouer en une
    // seconde plutot qu au bout d une demi-minute de travail.
    refuserCheminInterne(cheminSynthese, opts.archive, opts.out);
    refuserCheminInterne(cheminReleve, opts.archive, opts.out);

    const resultat = await anonymizeArchive({
      archiveDir: opts.archive,
      outDir: opts.out,
      force: opts.force ?? false,
      logger,
    });
    resumer(resultat, logger);

    logger.info("Controle des identites residuelles.");
    const controle = await controler(opts.archive, opts.out);

    // Le releve s ecrit d office quand le controle a trouve quelque chose : il
    // n y a alors rien a diffuser, et le detail est ce qu on cherche.
    const veutReleve = opts.releve !== undefined || controle.manquements.length > 0;
    const contexte: ContexteRapport = {
      resultat,
      controle,
      versionOutil: TOOL_VERSION,
      horodatage,
      releveProduit: veutReleve,
    };

    // Le rapport s ecrit AVANT de lever. Sans cela, la seule execution ou il
    // est indispensable serait precisement celle qui n en produirait aucun.
    await writeFile(cheminSynthese, rendreSynthese(contexte), "utf8");
    logger.info(`Synthese : ${cheminSynthese}`);
    if (veutReleve) {
      await writeFile(cheminReleve, rendreReleve(contexte), "utf8");
      logger.warn(`Releve : ${cheminReleve}`);
      logger.warn("  Il porte les formes residuelles. Ne pas le diffuser, le detruire ensuite.");
    }

    if (controle.manquements.length > 0) {
      for (const manquement of controle.manquements.slice(0, 20)) {
        logger.error(
          `${manquement.emplacement} ${manquement.champ} [${manquement.genre}] : ${manquement.extrait}`,
        );
      }
      const reste = controle.manquements.length - 20;
      if (reste > 0) logger.error(`et ${String(reste)} autre(s), tous au releve.`);
      throw new ResidualIdentityError(
        `${String(controle.manquements.length)} identite(s) ont survecu a l anonymisation. ` +
          "L archive produite ne doit pas etre diffusee.",
      );
    }

    logger.info(
      `Controle passe : ${String(controle.referencesVerifiees)} references et ` +
        `${String(controle.valeursVerifiees)} valeurs verifiees.`,
    );
    logger.warn("Ce controle ne couvre pas :");
    for (const limite of controle.horsControle) logger.warn(`  - ${limite}`);
    logger.warn("L archive produite n est pas encore diffusable. Lisez la synthese.");
  });

function resumer(resultat: AnonymizeResult, logger: Logger): void {
  const total = Object.values(resultat.references).reduce(
    (acc, categorie) => ({
      reecrites: acc.reecrites + categorie.reecrites,
      orphelines: acc.orphelines + categorie.orphelines,
    }),
    { reecrites: 0, orphelines: 0 },
  );
  logger.info(
    `${String(total.reecrites + resultat.props.referencesReecrites)} references d identite reecrites, ` +
      `${String(total.orphelines + resultat.props.referencesOrphelines)} retirees faute de compte correspondant.`,
  );
  logger.info(
    `props : ${String(resultat.props.clesRetirees)} cles retirees, ` +
      `${String(resultat.props.attachmentsReduits)} blocs attachments reduits a leur texte, ` +
      `${String(resultat.nomsSubstitues)} noms substitues dans le texte des messages systeme.`,
  );
}

async function controler(archiveDir: string, outDir: string): Promise<ResidualReport> {
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

  return checkResidualIdentities({ outDir, origine, substitution: { uids, usernames } });
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  new Logger().error(describeError(error));
  // Une saisie fautive se corrige et se relance ; une identite qui survit est
  // une panne de l outil, et l archive produite ne doit pas partir.
  process.exitCode = error instanceof ArchivePathError || error instanceof AnonymizeError ? 2 : 1;
}
