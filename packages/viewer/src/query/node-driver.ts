import { DatabaseSync, type StatementSync } from "node:sqlite";
import { INDEX_SCHEMA_VERSION } from "../index/schema.js";
import { IndexReadError, type SqlDriver, type SqlRow, type SqlValue } from "./driver.js";

/**
 * Pilote du mode full. Le pendant navigateur implemente la meme interface a
 * partir de SQLite compile en WebAssembly, sans qu aucune requete ne change.
 */
export class NodeSqlDriver implements SqlDriver {
  readonly #db: DatabaseSync;
  // Preparer une requete coute plus cher que l executer : sur une page de
  // messages, les memes quelques requetes reviennent a chaque appel.
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    try {
      this.#db = new DatabaseSync(path, { readOnly: true });
    } catch (cause) {
      throw new IndexReadError(
        `Index ${path} illisible. Construisez le avec mmarchive-index avant de servir l archive.`,
        { cause },
      );
    }
    this.#assertUsableIndex(path);
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.#prepare(sql).all(...params);
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    return this.#prepare(sql).get(...params);
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #assertUsableIndex(path: string): void {
    let version: unknown;
    try {
      version = this.#db
        .prepare("SELECT value FROM meta WHERE key = 'index_schema_version'")
        .get()?.value;
    } catch (cause) {
      throw new IndexReadError(
        `${path} n est pas un index mmarchive : la table meta est absente.`,
        { cause },
      );
    }
    if (version === undefined) {
      throw new IndexReadError(`${path} n est pas un index mmarchive : version absente.`);
    }
    if (Number(version) !== INDEX_SCHEMA_VERSION) {
      throw new IndexReadError(
        `Index en version ${String(version)}, ce viewer attend la version ${String(INDEX_SCHEMA_VERSION)}. Reconstruisez le : c est un derive de l archive, l operation prend une minute.`,
      );
    }
  }
}
