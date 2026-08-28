import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describeError } from "@mmarchive/shared";
import { Command } from "commander";
import pc from "picocolors";
import { type BuildProgress, type BuildReport, buildIndex } from "./index/build.js";
import { IndexReadError } from "./query/driver.js";
import { CHUNK_DEFAULTS } from "./rag/chunk.js";
import { type PlanReport, planChunks } from "./rag/plan.js";
import { TOOL_VERSION } from "./version.js";

/** Un nombre lisible : 311407 se compare mal, 311 407 se lit. */
const nb = (n: number): string => n.toLocaleString("fr-FR");

function printPlan(r: PlanReport, prixParMillion: number): void {
  const out = process.stderr;
  out.write(`${pc.green("Decoupage simule")}, rien n a ete envoye.\n`);
  out.write(
    `  ${nb(r.fragments)} fragments : ${nb(r.threads)} issus de fils, ${nb(r.windows)} de fenetres\n`,
  );
  out.write(`  ${nb(r.tokens)} tokens estimes\n`);
  out.write(
    `  taille en tokens : mediane ${nb(r.median)}, moyenne ${nb(r.mean)}, p90 ${nb(r.p90)}, p99 ${nb(r.p99)}, max ${nb(r.max)}\n`,
  );
  const total = r.closedByGap + r.closedByCap + r.closedByChannel;
  const part = (n: number): string => (total === 0 ? "0 %" : `${((n / total) * 100).toFixed(1)} %`);
  out.write(
    `  fenetres fermees par : silence ${part(r.closedByGap)}, plafond ${part(r.closedByCap)}, fin de canal ${part(r.closedByChannel)}\n`,
  );
  const cout = (r.tokens / 1e6) * prixParMillion;
  out.write(
    `  cout d une passe : ${cout.toFixed(2)} EUR, ${(cout / 2).toFixed(2)} EUR en mode batch\n`,
  );
}

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

program
  .command("plan-chunks")
  .description(
    "Simule le decoupage du RAG sans rien envoyer nulle part. Sert a regler la coupure temporelle en comparant deux essais.",
  )
  .option("--db <file>", "Index de consultation a lire", "./index.db")
  .option(
    "--gap <minutes>",
    "Silence au dela duquel une fenetre se ferme",
    String(CHUNK_DEFAULTS.gapMs / 60000),
  )
  .option(
    "--max-messages <n>",
    "Plafond de messages par fenetre",
    String(CHUNK_DEFAULTS.maxMessages),
  )
  .option(
    "--max-chars <n>",
    "Taille au dela de laquelle un fragment est coupe",
    String(CHUNK_DEFAULTS.maxChars),
  )
  .option("--price <eur>", "Prix au million de tokens, pour chiffrer la passe", "0.10")
  .option("--json", "Emet le rapport en JSON sur la sortie standard")
  .action((opts: Record<string, string | boolean | undefined>, commande: Command) => {
    const nombre = (nom: string, valeur: unknown, entier = false): number => {
      const n = Number(valeur);
      if (!Number.isFinite(n) || n <= 0 || (entier && !Number.isInteger(n))) {
        // Code 2 : argument invalide, comme le documente le README.
        commande.error(
          `--${nom} attend un ${entier ? "entier" : "nombre"} positif, recu "${String(valeur)}".`,
          { exitCode: 2 },
        );
      }
      return n;
    };
    const chemin = String(opts.db ?? "./index.db");
    if (!existsSync(chemin)) {
      throw new IndexReadError(
        `Index ${chemin} introuvable. Construisez le avec mmarchive-index avant de planifier le decoupage.`,
      );
    }

    const db = new DatabaseSync(chemin, { readOnly: true });
    try {
      const rapport = planChunks(db, {
        gapMs: nombre("gap", opts.gap) * 60000,
        maxMessages: nombre("max-messages", opts.maxMessages, true),
        maxChars: nombre("max-chars", opts.maxChars, true),
      });
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(rapport, null, 2)}\n`);
      } else {
        printPlan(rapport, nombre("price", opts.price));
      }
    } finally {
      db.close();
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${pc.red("Echec")} : ${describeError(error)}\n`);
  process.exitCode = 1;
}
