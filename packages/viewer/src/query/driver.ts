/**
 * Frontiere entre les requetes et le moteur SQLite qui les execute.
 *
 * Elle est volontairement minuscule, et surtout synchrone : c est ce qui permet
 * au meme code de requetes de tourner dans le processus Node du mode full et
 * dans le worker du mode lite. Ce qui differe d un mode a l autre n est pas la
 * requete mais le transport, qui vit au dessus de cette interface.
 *
 * Rendre cette interface asynchrone serait la seule maniere de la casser : ni
 * node:sqlite ni SQLite compile en WebAssembly ne savent rendre la main au
 * milieu d une requete.
 */
export type SqlValue = string | number | null;

export type SqlRow = Record<string, unknown>;

export interface SqlDriver {
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  get(sql: string, params?: readonly SqlValue[]): SqlRow | undefined;
  close(): void;
}

export class IndexReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexReadError";
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture typee des colonnes                                                  */
/* -------------------------------------------------------------------------- */

export function num(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new IndexReadError(`Colonne ${key} attendue numerique, recue ${typeof value}.`);
}

export function numOrNull(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return num(row, key);
}

export function str(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  throw new IndexReadError(`Colonne ${key} attendue textuelle, recue ${typeof value}.`);
}

export function strOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return str(row, key);
}
