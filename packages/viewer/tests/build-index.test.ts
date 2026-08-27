import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex, IndexBuildError } from "../src/index/build.js";

import {
  BOB,
  CHANNEL_A,
  CHANNEL_B,
  channel,
  FILE_KEPT,
  FILE_SKIPPED,
  id,
  manifest,
  post,
  writeArchive,
  writeNdjson,
} from "./helpers/archive.js";

let workDir: string;
let archiveDir: string;
let indexPath: string;

function open(): DatabaseSync {
  return new DatabaseSync(indexPath, { readOnly: true });
}

function rows(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-index-"));
  archiveDir = join(workDir, "archive");
  indexPath = join(workDir, "index.db");
  await writeArchive(archiveDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("construction de l index", () => {
  it("n indexe que les messages humains", async () => {
    const report = await buildIndex({ archiveRoot: archiveDir, output: indexPath });

    expect(report.posts).toBe(5);
    expect(report.skippedNonHuman).toBe(2);

    const db = open();
    expect(rows(db, "SELECT count(*) c FROM post")[0]?.c).toBe(5);
    db.close();
  });

  it("attribue les rowid dans l ordre chronologique global, canaux confondus", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    const db = open();

    const ordered = rows(db, "SELECT rowid, create_at, ch FROM post ORDER BY rowid");
    expect(ordered.map((r) => r.create_at)).toEqual([100, 200, 300, 400, 500]);
    // Les deux canaux s entrelacent : un rowid groupe par canal donnerait
    // 100, 300, 500, 200, 400.
    expect(ordered.map((r) => r.ch)).toEqual([1, 2, 1, 2, 1]);
    db.close();
  });

  it("ne laisse aucune inversion entre rowid et create_at", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    const db = open();

    const violations = rows(
      db,
      "SELECT count(*) c FROM post a JOIN post b ON b.rowid = a.rowid + 1 WHERE b.create_at < a.create_at",
    );
    expect(violations[0]?.c).toBe(0);
    db.close();
  });

  it("rend le tri par rowid equivalent au tri par date", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    const db = open();

    const byRowid = rows(db, "SELECT pid FROM post ORDER BY rowid DESC").map((r) => r.pid);
    const byDate = rows(db, "SELECT pid FROM post ORDER BY create_at DESC, pid DESC").map(
      (r) => r.pid,
    );
    expect(byRowid).toEqual(byDate);
    db.close();
  });

  it("resout les racines de fil et laisse les orphelines a null", async () => {
    const report = await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    expect(report.orphanRoots).toBe(1);

    const db = open();
    const reply = rows(db, "SELECT root FROM post WHERE pid = ?", id("a", 2))[0];
    const rootRowid = rows(db, "SELECT rowid FROM post WHERE pid = ?", id("a", 1))[0]?.rowid;
    expect(reply?.root).toBe(rootRowid);

    const orphan = rows(db, "SELECT root FROM post WHERE pid = ?", id("b", 2))[0];
    expect(orphan?.root).toBeNull();
    db.close();
  });

  it("rattache les reactions au message", async () => {
    const report = await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    expect(report.reactions).toBe(2);

    const db = open();
    const found = rows(
      db,
      "SELECT r.emoji FROM reaction r JOIN post p ON p.rowid = r.post WHERE p.pid = ? ORDER BY r.emoji",
      id("a", 2),
    );
    expect(found.map((r) => r.emoji)).toEqual(["+1", "perroquet"]);
    db.close();
  });

  it("conserve une piece jointe non archivee avec sa raison", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    const db = open();

    const skipped = rows(
      db,
      "SELECT name, path, skip_reason FROM file WHERE fid = ?",
      FILE_SKIPPED,
    )[0];
    expect(skipped?.path).toBeNull();
    expect(skipped?.skip_reason).toBe("too_large");

    const kept = rows(db, "SELECT path, skip_reason FROM file WHERE fid = ?", FILE_KEPT)[0];
    expect(kept?.path).toBe(`attachments/${FILE_KEPT}/cadrage.pdf`);
    expect(kept?.skip_reason).toBeNull();
    db.close();
  });

  it("compte les messages de chaque canal et sa plage temporelle", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    const db = open();

    const a = rows(db, "SELECT posts, first_at, last_at FROM channel WHERE cid = ?", CHANNEL_A)[0];
    expect(a).toEqual({ posts: 3, first_at: 100, last_at: 500 });
    db.close();
  });
});

describe("recherche", () => {
  beforeEach(async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
  });

  it("trouve un mot et rend les resultats du plus recent au plus ancien", () => {
    const db = open();
    const found = rows(
      db,
      "SELECT rowid FROM search WHERE search MATCH 'message:reunion' ORDER BY rowid DESC",
    );
    expect(found.map((r) => r.rowid)).toEqual([2, 1]);
    db.close();
  });

  it("distingue la phrase exacte d une simple conjonction de mots", () => {
    const db = open();
    const phrase = rows(
      db,
      `SELECT rowid FROM search WHERE search MATCH 'message:"note de cadrage"'`,
    );
    expect(phrase).toHaveLength(1);

    const words = rows(
      db,
      `SELECT rowid FROM search WHERE search MATCH 'message:(note AND reunion)'`,
    );
    expect(words).toHaveLength(0);
    db.close();
  });

  it("ignore les accents dans la requete comme dans le texte", () => {
    const db = open();
    // Le corpus contient "reportee" sans accent et "reunion" sans accent : la
    // requete accentuee doit tout de meme les atteindre.
    const found = rows(db, "SELECT rowid FROM search WHERE search MATCH 'message:réunion'");
    expect(found.length).toBeGreaterThan(0);
    db.close();
  });

  it("restreint a un canal sans jointure, via le terme indexe", () => {
    const db = open();
    const channelRow = rows(db, "SELECT id FROM channel WHERE cid = ?", CHANNEL_B)[0]?.id;
    const found = rows(
      db,
      `SELECT rowid FROM search WHERE search MATCH 'message:reunion AND tag:c${String(channelRow)}'`,
    );
    expect(found).toHaveLength(1);
    db.close();
  });

  it("restreint a un auteur, via le terme indexe", () => {
    const db = open();
    const bob = rows(db, "SELECT id FROM user WHERE uid = ?", BOB)[0]?.id;
    const found = rows(
      db,
      `SELECT p.pid FROM search s JOIN post p ON p.rowid = s.rowid WHERE s.search MATCH 'tag:u${String(bob)}' ORDER BY s.rowid`,
    );
    expect(found.map((r) => r.pid)).toEqual([id("b", 1), id("a", 3)]);
    db.close();
  });

  it("n indexe pas le contenu des messages de bots", () => {
    const db = open();
    const found = rows(db, "SELECT rowid FROM search WHERE search MATCH 'message:notification'");
    expect(found).toHaveLength(0);
    db.close();
  });
});

describe("garde-fous", () => {
  it("refuse une archive dont le format est plus recent que l outil", async () => {
    await writeFile(
      join(archiveDir, "manifest.json"),
      JSON.stringify(manifest({ schema_version: 99 })),
      "utf8",
    );
    await expect(buildIndex({ archiveRoot: archiveDir, output: indexPath })).rejects.toThrow(
      IndexBuildError,
    );
  });

  it("refuse un canal non public, meme decrit comme tel dans l archive", async () => {
    await writeNdjson(join(archiveDir, "channels.ndjson"), [
      channel(CHANNEL_A),
      channel(CHANNEL_B, { type: "P" }),
    ]);
    await expect(buildIndex({ archiveRoot: archiveDir, output: indexPath })).rejects.toThrow();
  });

  it("refuse d ecraser un index existant sans y avoir ete autorise", async () => {
    await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    await expect(buildIndex({ archiveRoot: archiveDir, output: indexPath })).rejects.toThrow(
      /--force/,
    );
    await expect(
      buildIndex({ archiveRoot: archiveDir, output: indexPath, force: true }),
    ).resolves.toMatchObject({ posts: 5 });
  });

  it("signale un canal annonce dont le fichier de messages manque", async () => {
    await rm(join(archiveDir, "posts", `${CHANNEL_B}.ndjson`));
    const report = await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    expect(report.missingPostFiles).toEqual([CHANNEL_B]);
    expect(report.posts).toBe(3);
  });

  it("signale un fichier de messages sans canal correspondant", async () => {
    await writeNdjson(join(archiveDir, "posts", `${"z".repeat(26)}.ndjson`), [post()]);
    const report = await buildIndex({ archiveRoot: archiveDir, output: indexPath });
    expect(report.orphanPostFiles).toEqual(["z".repeat(26)]);
  });

  it("ne laisse pas d index a moitie construit derriere une erreur", async () => {
    // Sans ce nettoyage, la tentative suivante serait refusee au motif qu un
    // index existe deja, alors que celui la est inutilisable.
    await writeFile(
      join(archiveDir, "posts", `${CHANNEL_A}.ndjson`),
      '{"pas":"un message"}\n',
      "utf8",
    );
    await expect(buildIndex({ archiveRoot: archiveDir, output: indexPath })).rejects.toThrow();
    await expect(stat(indexPath)).rejects.toThrow();
  });

  it("refuse une archive sans manifeste", async () => {
    await rm(join(archiveDir, "manifest.json"));
    await expect(buildIndex({ archiveRoot: archiveDir, output: indexPath })).rejects.toThrow(
      IndexBuildError,
    );
  });
});
