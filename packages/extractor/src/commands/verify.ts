import { resolve } from "node:path";
import { verifyArchive } from "../verify/checks.js";
import { Logger } from "../ui/logger.js";

export interface VerifyCommandOptions {
  readonly archive?: string | undefined;
  readonly blobs?: boolean | undefined;
}

/**
 * Verifie une archive et renvoie le nombre d erreurs, pour que l appelant
 * puisse en faire un code de sortie exploitable dans un script.
 */
export async function verifyCommand(
  raw: VerifyCommandOptions,
  logger = new Logger(),
): Promise<number> {
  const archiveDir = resolve(raw.archive ?? "./archive");

  logger.section("Verification de l archive");
  logger.info(archiveDir);

  const report = await verifyArchive({
    archiveDir,
    checkBlobs: raw.blobs ?? true,
    onProgress: (step) => {
      logger.debug(`Controle : ${step}`);
    },
  });

  for (const result of report.results) {
    if (result.severity === "error") {
      logger.error(`${result.label}${result.detail === undefined ? "" : ` : ${result.detail}`}`);
    } else if (result.severity === "warning") {
      logger.warn(`${result.label}${result.detail === undefined ? "" : ` : ${result.detail}`}`);
    } else {
      logger.info(`${result.label}${result.detail === undefined ? "" : ` : ${result.detail}`}`);
    }
  }

  logger.section("Resultat");
  if (report.errors === 0) {
    logger.success(
      report.warnings === 0
        ? "Archive conforme."
        : `Archive conforme, ${String(report.warnings)} avertissement(s).`,
    );
  } else {
    logger.error(
      `${String(report.errors)} controle(s) en echec, ${String(report.warnings)} avertissement(s).`,
    );
  }
  return report.errors;
}
