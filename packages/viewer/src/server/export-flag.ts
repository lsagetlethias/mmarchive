import { ERROR_CODES, type ErrorCode } from "@mmarchive/shared";

export class ExportFlagError extends Error {
  readonly code: ErrorCode = ERROR_CODES.ExportFlagError;
  constructor(message: string) {
    super(message);
    this.name = "ExportFlagError";
  }
}

const ENABLED = new Set(["1", "true"]);
const DISABLED = new Set(["", "0", "false"]);

/**
 * Lecture stricte : une valeur mal orthographiee leve plutot que de laisser
 * l export dans un etat que l operateur n a pas choisi.
 */
export function parseExportFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (ENABLED.has(value)) return true;
  if (DISABLED.has(value)) return false;
  throw new ExportFlagError(
    `MMARCHIVE_EXPORT vaut "${raw}" : valeurs acceptees 1, true, 0, false.`,
  );
}
