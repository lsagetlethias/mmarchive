import { existsSync } from "node:fs";
import { codeDeSortieCommander, describeError } from "@mmarchive/shared";
import { Command } from "commander";
import pc from "picocolors";
import { NodeSqlDriver } from "./query/node-driver.js";
import { createServer } from "./server/app.js";
import { TOOL_VERSION } from "./version.js";

const program = new Command();
program.exitOverride((erreur) => {
  process.exit(codeDeSortieCommander(erreur.code));
});
program
  .name("mmarchive-serve")
  .description("Sert une archive mmarchive en lecture seule.")
  .version(TOOL_VERSION, "-V, --version", "Affiche la version et quitte")
  .helpOption("-h, --help", "Affiche cette aide")
  .requiredOption("--index <file>", "Index construit par mmarchive-index")
  .requiredOption("--archive <dir>", "Racine de l archive, pour les pieces jointes")
  .option("--port <number>", "Port d ecoute", "4173")
  // Ces echanges ne sont pas destines a etre exposes : l ecoute reste locale
  // tant que l operateur ne demande pas explicitement le contraire.
  .option("--host <host>", "Interface d ecoute", "127.0.0.1")
  .option("--web <dir>", "Frontend construit a servir", "packages/viewer/web/dist")
  .option(
    "--standalone <file>",
    "Viewer en un seul fichier, inclus dans la copie autonome",
    "packages/viewer/web/dist-standalone/archive.html",
  )
  .option("--verbose", "Journalise chaque requete")
  .action(
    async (opts: {
      index: string;
      archive: string;
      port: string;
      host: string;
      web?: string;
      standalone?: string;
      verbose?: boolean;
    }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write(`${pc.red("Echec")} : port invalide (${opts.port}).\n`);
        process.exitCode = 1;
        return;
      }

      const driver = new NodeSqlDriver(opts.index);
      const app = createServer({
        driver,
        archiveRoot: opts.archive,
        ...(opts.web === undefined || !existsSync(opts.web) ? {} : { webRoot: opts.web }),
        ...(opts.standalone === undefined || !existsSync(opts.standalone)
          ? {}
          : { standalonePath: opts.standalone }),
        indexPath: opts.index,
        logger: opts.verbose ?? false,
      });
      if (opts.web !== undefined && !existsSync(opts.web)) {
        process.stderr.write(
          `${pc.yellow("Note")} : ${opts.web} est absent, seule l API est servie. Construisez le frontend avec pnpm --filter @mmarchive/viewer build:web.\n`,
        );
      }

      const shutdown = (): void => {
        void app.close().then(() => {
          driver.close();
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await app.listen({ port, host: opts.host });
      process.stdout.write(
        `${pc.green("Archive servie")} sur http://${opts.host}:${String(port)}\n`,
      );
      if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
        process.stderr.write(
          `${pc.yellow("Attention")} : l ecoute n est pas limitee a cette machine. Ces echanges ne sont pas destines a etre exposes.\n`,
        );
      }
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${pc.red("Echec")} : ${describeError(error)}\n`);
  process.exitCode = 1;
}
