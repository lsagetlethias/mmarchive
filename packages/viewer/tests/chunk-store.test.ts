import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChunkStore, openChunkStore } from "../src/rag/chunk-store.js";
import { indexFingerprint, missingStoreTables } from "../src/rag/store-schema.js";

const MINUTE = 60 * 1000;
let workDir: string;
let indexPath: string;
let storePath: string;

function creerIndex(
  posts: { id: number; pid: string; at?: number; root?: number | null; msg?: string }[],
): void {
  const db = new DatabaseSync(indexPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE channel (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE post (rowid INTEGER PRIMARY KEY, pid TEXT, ch INTEGER, usr INTEGER, create_at INTEGER, root INTEGER);
    CREATE TABLE post_text (rowid INTEGER PRIMARY KEY, message TEXT);
    INSERT INTO channel VALUES (1, 'general');
    INSERT INTO user VALUES (1, 'alice'), (2, 'bob');
  `);
  for (const p of posts) {
    db.prepare("INSERT INTO post VALUES (?, ?, 1, 1, ?, ?)").run(
      p.id,
      p.pid,
      p.at ?? p.id * MINUTE,
      p.root ?? null,
    );
    db.prepare("INSERT INTO post_text VALUES (?, ?)").run(p.id, p.msg ?? "un message");
  }
  db.close();
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-chunks-"));
  indexPath = join(workDir, "index.db");
  storePath = join(workDir, "vectors.db");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("buildChunkStore", () => {
  it("ecrit les fragments, leurs bornes et leurs participants", async () => {
    creerIndex([
      { id: 1, pid: "a".repeat(26) },
      { id: 2, pid: "b".repeat(26), root: 1 },
    ]);
    const rapport = await buildChunkStore({ indexPath, output: storePath });
    expect(rapport.fragments).toBe(1);
    expect(rapport.threads).toBe(1);

    const db = new DatabaseSync(storePath, { readOnly: true });
    const f = db.prepare("SELECT * FROM fragment").get();
    expect(f).toMatchObject({ ch: 1, root: 1, first_id: 1, last_id: 2, messages: 2 });
    expect(db.prepare("SELECT count(*) n FROM fragment_user").get()?.n).toBe(1);
    db.close();
  });

  it("declare toutes les tables que la relecture exige", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });
    const db = new DatabaseSync(storePath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name));
    db.close();
    expect(missingStoreTables(tables)).toEqual([]);
  });

  it("garde la trace des reglages qui ont produit ces fragments", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath, gapMs: 12345, maxMessages: 7 });
    const db = new DatabaseSync(storePath, { readOnly: true });
    const lire = (k: string): string =>
      String(db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value ?? "");
    expect(lire("gap_ms")).toBe("12345");
    expect(lire("max_messages")).toBe("7");
    db.close();
  });

  it("ne laisse pas de reserve a moitie ecrite derriere une erreur", async () => {
    // L index doit tenir assez longtemps pour que le fichier de sortie soit
    // cree, puis casser pendant l ecriture : un echec avant la creation ne
    // prouverait rien du nettoyage. Sans post_text, le parcours echoue a sa
    // premiere ligne, une fois la reserve ouverte.
    const db = new DatabaseSync(indexPath);
    db.exec(`
      CREATE TABLE channel (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE post (rowid INTEGER PRIMARY KEY, pid TEXT, ch INTEGER, usr INTEGER, create_at INTEGER, root INTEGER);
      INSERT INTO post VALUES (1, 'aaa', 1, 1, 0, NULL);
    `);
    db.close();
    await expect(buildChunkStore({ indexPath, output: storePath })).rejects.toThrow();
    // Une reserve partielle passerait le controle de presence des tables et
    // servirait des fragments incomplets sans rien signaler.
    const { existsSync } = await import("node:fs");
    expect(existsSync(storePath)).toBe(false);
  });
});

describe("protection des fichiers", () => {
  it("refuse d ecrire la reserve dans l index lui meme", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    // Avec --force, cet appel effacerait l index en cours de lecture.
    await expect(buildChunkStore({ indexPath, output: indexPath, force: true })).rejects.toThrow(
      /meme fichier/,
    );
    const { existsSync } = await import("node:fs");
    expect(existsSync(indexPath)).toBe(true);
  });

  it("refuse de remplacer une reserve existante sans --force", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });
    await expect(buildChunkStore({ indexPath, output: storePath })).rejects.toThrow(/--force/);
  });

  it("laisse la reserve existante intacte quand il refuse", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });
    const { readFileSync } = await import("node:fs");
    const avant = readFileSync(storePath);
    await expect(buildChunkStore({ indexPath, output: storePath })).rejects.toThrow();
    // Le refus ne doit rien couter : ouvrir puis echouer sur les tables deja
    // presentes ferait supprimer par le nettoyage ce qu on venait de proteger.
    expect(readFileSync(storePath).equals(avant)).toBe(true);
  });

  it("laisse la reserve existante intacte quand la reconstruction echoue", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });
    const { readFileSync } = await import("node:fs");
    const avant = readFileSync(storePath);

    const casse = new DatabaseSync(indexPath);
    casse.exec("DROP TABLE post_text");
    casse.close();

    await expect(buildChunkStore({ indexPath, output: storePath, force: true })).rejects.toThrow();
    expect(readFileSync(storePath).equals(avant)).toBe(true);
  });

  it("ne laisse pas de fichier partiel derriere lui", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    const casse = new DatabaseSync(indexPath);
    casse.exec("DROP TABLE post_text");
    casse.close();
    await expect(buildChunkStore({ indexPath, output: storePath })).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${storePath}.partiel`)).toBe(false);
  });
});

describe("openChunkStore", () => {
  it("accepte une reserve construite depuis cet index", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });
    const index = new DatabaseSync(indexPath, { readOnly: true });
    const store = openChunkStore(storePath, index);
    expect(store.prepare("SELECT count(*) n FROM fragment").get()?.n).toBe(1);
    store.close();
    index.close();
  });

  it("refuse une reserve quand seuls les noms ont change", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });

    // Une pseudonymisation laisse les messages en place, donc la suite des
    // identifiants intacte. Sans les noms dans l empreinte, la reserve passerait
    // et restituerait les identites qu on venait d effacer.
    const modifie = new DatabaseSync(indexPath);
    modifie.exec("UPDATE user SET username = 'anon-1234' WHERE id = 1");
    modifie.close();

    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      expect(() => openChunkStore(storePath, index)).toThrow(/autre index/);
    } finally {
      index.close();
    }
  });

  it("refuse une reserve quand un message a ete edite", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26), msg: "la version d origine" }]);
    await buildChunkStore({ indexPath, output: storePath });

    // Un message edite garde son identifiant et sa place : une reextraction en
    // rapporte le nouveau texte sans que rien d autre ne bouge. La reserve
    // servirait alors la version d avant, et l archive et le RAG raconteraient
    // deux choses differentes.
    const modifie = new DatabaseSync(indexPath);
    modifie.exec("UPDATE post_text SET message = 'la version corrigee' WHERE rowid = 1");
    modifie.close();

    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      expect(() => openChunkStore(storePath, index)).toThrow(/autre index/);
    } finally {
      index.close();
    }
  });

  it("refuse une reserve dont l index a change sous elle", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    await buildChunkStore({ indexPath, output: storePath });

    // Un message insere decale la numerotation de tout ce qui suit. Les bornes
    // des fragments designeraient alors d autres messages, et le RAG citerait
    // des propos que personne n a tenus.
    const modifie = new DatabaseSync(indexPath);
    modifie.prepare("INSERT INTO post VALUES (2, ?, 1, 1, 999, NULL)").run("z".repeat(26));
    modifie.close();

    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      expect(() => openChunkStore(storePath, index)).toThrow(/autre index/);
    } finally {
      index.close();
    }
  });

  it("refuse un fichier qui n a pas la forme d une reserve", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    const bidon = join(workDir, "bidon.db");
    const db = new DatabaseSync(bidon);
    db.exec("CREATE TABLE autre (x)");
    db.close();
    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      expect(() => openChunkStore(bidon, index)).toThrow(/forme attendue/);
    } finally {
      index.close();
    }
  });
});

describe("indexFingerprint", () => {
  it("ne bouge pas quand l index ne bouge pas", async () => {
    creerIndex([
      { id: 1, pid: "a".repeat(26) },
      { id: 2, pid: "b".repeat(26) },
    ]);
    const db = new DatabaseSync(indexPath, { readOnly: true });
    expect(indexFingerprint(db)).toBe(indexFingerprint(db));
    db.close();
  });

  it("change des qu un message entre ou sort", async () => {
    creerIndex([{ id: 1, pid: "a".repeat(26) }]);
    const avant = (() => {
      const db = new DatabaseSync(indexPath, { readOnly: true });
      const e = indexFingerprint(db);
      db.close();
      return e;
    })();

    const modifie = new DatabaseSync(indexPath);
    modifie.prepare("INSERT INTO post VALUES (2, ?, 1, 1, 2, NULL)").run("b".repeat(26));
    modifie.close();

    const db = new DatabaseSync(indexPath, { readOnly: true });
    expect(indexFingerprint(db)).not.toBe(avant);
    db.close();
  });
});
