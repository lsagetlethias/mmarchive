import { resolve } from "node:path";
import { Logger } from "../ui/logger.js";
import { RunReporter } from "../ui/run-reporter.js";
import { verifyArchive } from "../verify/checks.js";

export interface VerifyCommandOptions {
  readonly archive?: string | undefined;
  readonly blobs?: boolean | undefined;
  /** Sortie exploitable par un script, sur la sortie standard. */
  readonly json?: boolean | undefined;
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

  // En mode structure, la sortie standard ne porte QUE le JSON : tout le reste
  // part sur la sortie d erreur, sinon "verify --json | jq" echoue.
  const asJson = raw.json ?? false;
  if (!asJson) {
    logger.section("Verification de l archive");
    logger.info(archiveDir);
  }

  // Une verification complete lit toute l archive : plusieurs minutes sans le
  // moindre signe si l on n affiche rien.
  const progress = new RunReporter({ estimatedMessages: 0, interactive: !asJson && undefined });
  if (!asJson) {
    progress.start();
    progress.phase("Lecture de l archive");
  }

  const report = await verifyArchive({
    archiveDir,
    checkBlobs: raw.blobs ?? true,
    onProgress: (step, done, total) => {
      if (asJson) return;
      if (total !== undefined && total > 0) {
        progress.phase(step, total);
        if (done !== undefined) progress.phaseProgress(done);
      } else if (done !== undefined) {
        progress.phaseProgress(done);
      } else {
        progress.phase(step);
      }
    },
  });
  progress.stop();

  if (asJson) {
    const payload = {
      archive: archiveDir,
      conformant: report.errors === 0,
      errors: report.errors,
      warnings: report.warnings,
      checks: report.results.map((result) => ({
        severity: result.severity,
        label: result.label,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return report.errors;
  }

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
