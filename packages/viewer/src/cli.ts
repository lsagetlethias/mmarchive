import { describeError } from "@mmarchive/shared";
import { Command } from "commander";
import pc from "picocolors";
import { type BuildProgress, type BuildReport, buildIndex } from "./index/build.js";
import { TOOL_VERSION } from "./version.js";

const STEP_LABEL: Record<BuildProgress["step"], string> = {
  manifest: "Lecture du manifeste",
  channels: "Canaux",
  users: "Utilisateurs",
  emojis: "Emojis",
  posts: "Messages",
  chronologie: "Numerotation chronologique",
  fils: "Resolution des fils",
  reactions: "Reactions",
  fichiers: "Pieces jointes",
  ressources: "Avatars et emojis",
  recherche: "Index de recherche",
  compactage: "Compactage",
};

function formatBytes(bytes: number): string {
  const mo = bytes / 1024 / 1024;
  return mo >= 1024 ? `${(mo / 1024).toFixed(2)} Go` : `${mo.toFixed(0)} Mo`;
}

function formatCount(value: number): string {
  return value.toLocaleString("fr-FR");
}

/**
 * La progression va sur la sortie d erreur et le resultat sur la sortie
 * standard : sans cette separation, toute sortie structuree devient
 * inexploitable dans un tube.
 */
function reportProgress(progress: BuildProgress): void {
  // Une etape emet aussi son demarrage a zero : l afficher doublerait chaque
  // ligne sans rien apprendre, seules les etapes longues ont des jalons.
  if (progress.done === 0) return;
  process.stderr.write(
    `${pc.dim("...")} ${STEP_LABEL[progress.step]} ${formatCount(progress.done)}\n`,
  );
}

function printReport(report: BuildReport, output: string): void {
  const lines = [
    `${pc.green("Index construit")} : ${output}`,
    `  ${formatCount(report.posts)} messages, ${formatCount(report.channels)} canaux, ${formatCount(report.users)} utilisateurs`,
    `  ${formatCount(report.reactions)} reactions, ${formatCount(report.files)} pieces jointes`,
    `  ${formatCount(report.assets)} avatars et emojis inclus`,
    `  ${formatBytes(report.bytes)} en ${(report.durationMs / 1000).toFixed(1)} s`,
  ];
  if (report.skippedNonHuman > 0) {
    lines.push(
      `  ${formatCount(report.skippedNonHuman)} messages de bots et systeme ecartes de l index`,
    );
  }
  if (report.orphanRoots > 0) {
    lines.push(
      `  ${pc.yellow(formatCount(report.orphanRoots))} reponses dont la racine est hors de l index`,
    );
  }
  for (const cid of report.missingPostFiles) {
    lines.push(`  ${pc.yellow("canal sans fichier de messages")} : ${cid}`);
  }
  for (const cid of report.orphanPostFiles) {
    lines.push(`  ${pc.yellow("fichier de messages sans canal")} : ${cid}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

const program = new Command();
program
  .name("mmarchive-index")
  .description("Construit l index de consultation d une archive mmarchive.")
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .helpOption("-h, --help", "Affiche cette aide")
  .option("--no-color", "Desactive la couleur (equivalent a NO_COLOR)");

program.on("option:no-color", () => {
  process.env.NO_COLOR = "1";
});

program
  .command("build", { isDefault: true })
  .description(
    "Construit l index a partir d une archive. L index est toujours reconstruit en entier.",
  )
  .requiredOption("--archive <dir>", "Racine de l archive a indexer")
  .option("--out <file>", "Fichier d index a produire", "./index.db")
  .option("--force", "Remplace un index existant")
  .option(
    "--no-embed-assets",
    "N inclut pas avatars et emojis dans l index. Le mode sans serveur ne pourra alors plus les afficher.",
  )
  .option("--json", "Emet le rapport en JSON sur la sortie standard")
  .action(
    async (opts: {
      archive: string;
      out: string;
      force?: boolean;
      embedAssets?: boolean;
      json?: boolean;
    }) => {
      const quiet = opts.json ?? false;
      const report = await buildIndex({
        archiveRoot: opts.archive,
        output: opts.out,
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.embedAssets === undefined ? {} : { embedAssets: opts.embedAssets }),
        ...(quiet ? {} : { onProgress: reportProgress }),
      });
      if (quiet) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printReport(report, opts.out);
      }
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${pc.red("Echec")} : ${describeError(error)}\n`);
  process.exitCode = 1;
}
