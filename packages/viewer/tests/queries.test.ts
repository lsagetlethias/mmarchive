import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/index/build.js";
import { IndexReadError, type SqlDriver } from "../src/query/driver.js";
import { NodeSqlDriver } from "../src/query/node-driver.js";
import {
  getChannelByName,
  getMessageByPid,
  getMessageContext,
  getThread,
  listAttachments,
  listChannelMessages,
  listChannels,
  listReactions,
  listUsers,
  rowidAtOrAfter,
  searchMessages,
} from "../src/query/queries.js";
import { id, writeArchive, writeDatedArchive } from "./helpers/archive.js";

let workDir: string;
let driver: SqlDriver;
let datedDriver: SqlDriver;

const DAYS = 120;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-queries-"));

  const archive = join(workDir, "archive");
  await writeArchive(archive);
  const index = join(workDir, "index.db");
  await buildIndex({ archiveRoot: archive, output: index });
  driver = new NodeSqlDriver(index);

  const dated = join(workDir, "dated");
  await writeDatedArchive(dated, DAYS);
  const datedIndex = join(workDir, "dated.db");
  await buildIndex({ archiveRoot: dated, output: datedIndex });
  datedDriver = new NodeSqlDriver(datedIndex);
});

afterAll(async () => {
  driver.close();
  datedDriver.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("canaux et utilisateurs", () => {
  it("liste les canaux du plus recemment actif au plus ancien", () => {
    const channels = listChannels(driver);
    expect(channels.map((c) => c.name)).toEqual(["general", "tech-archi"]);
    expect(channels[0]?.posts).toBe(3);
    expect(channels[0]?.lastAt).toBe(500);
  });

  it("retrouve un canal par son nom, comme le fait in:", () => {
    expect(getChannelByName(driver, "tech-archi")?.cid).toBeDefined();
    expect(getChannelByName(driver, "inexistant")).toBeUndefined();
  });

  it("expose le nom affichable et l etat des comptes", () => {
    const users = listUsers(driver);
    expect(users.map((u) => u.username)).toEqual(["alice", "bob"]);
    expect(users[0]?.display).toBe("Alice Martin");
    expect(users[0]?.deactivated).toBe(false);
  });
});

describe("lecture d un canal", () => {
  it("rend les messages du plus recent au plus ancien", () => {
    const channel = getChannelByName(driver, "general");
    const page = listChannelMessages(driver, channel?.id ?? 0);
    expect(page.items.map((m) => m.createAt)).toEqual([500, 300, 100]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pagine par curseur sans jamais sauter ni repeter un message", () => {
    const channelId = getChannelByName(datedDriver, "general")?.id ?? 0;
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page: ReturnType<typeof listChannelMessages> = listChannelMessages(
        datedDriver,
        channelId,
        cursor === undefined ? { limit: 7 } : { limit: 7, before: cursor },
      );
      seen.push(...page.items.map((m) => m.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(DAYS / 2);
    expect(new Set(seen).size).toBe(seen.length);
    // Strictement decroissant : c est la garantie que le curseur ne recule pas.
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it("porte les indicateurs d edition et de piece jointe", () => {
    const channelId = getChannelByName(driver, "general")?.id ?? 0;
    const latest = listChannelMessages(driver, channelId).items[0];
    expect(latest?.edited).toBe(true);
    expect(latest?.hasFiles).toBe(true);
    expect(latest?.deleted).toBe(false);
  });
});

describe("fils et permaliens", () => {
  it("rend une racine et ses reponses", () => {
    const root = getMessageByPid(driver, id("a", 1));
    const thread = getThread(driver, root?.id ?? 0);
    expect(thread.root?.pid).toBe(id("a", 1));
    expect(thread.replies.map((m) => m.pid)).toEqual([id("a", 2)]);
  });

  it("resout un permalien par identifiant Mattermost", () => {
    const message = getMessageByPid(driver, id("a", 3));
    expect(message?.message).toBe("note de cadrage a relire");
    expect(getMessageByPid(driver, id("z", 1))).toBeUndefined();
  });

  it("rend un message dans son contexte, sans deborder du canal", () => {
    const target = getMessageByPid(driver, id("a", 2));
    const context = getMessageContext(driver, target?.id ?? 0, 10);
    expect(context.message?.pid).toBe(id("a", 2));
    expect(context.before.map((m) => m.pid)).toEqual([id("a", 1)]);
    expect(context.after.map((m) => m.pid)).toEqual([id("a", 3)]);
  });

  it("rend les reponses meme quand la racine est absente de l index", () => {
    // La racine peut etre hors fenetre, ou portee par un message de bot : la
    // conversation doit rester lisible malgre tout.
    const orphan = getMessageByPid(driver, id("b", 2));
    expect(orphan).toBeDefined();
    expect(orphan?.rootId).toBeNull();
  });
});

describe("reactions et pieces jointes", () => {
  it("rend les reactions d une plage de messages", () => {
    const reactions = listReactions(driver, 1, 10);
    expect(reactions.map((r) => r.emoji).sort()).toEqual(["+1", "perroquet"]);
  });

  it("annonce une piece jointe non archivee au lieu de la masquer", () => {
    const attachments = listAttachments(driver, 1, 10);
    const skipped = attachments.find((a) => a.path === null);
    expect(skipped?.name).toBe("video.mov");
    expect(skipped?.skipReason).toBe("too_large");
    expect(attachments.find((a) => a.path !== null)?.name).toBe("cadrage.pdf");
  });
});

describe("recherche", () => {
  it("trouve par mot, du plus recent au plus ancien", () => {
    const result = searchMessages(driver, "reunion");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.page.items.map((m) => m.createAt)).toEqual([200, 100]);
  });

  it("applique la phrase exacte", () => {
    const result = searchMessages(driver, '"note de cadrage"');
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items).toHaveLength(1);
  });

  it("restreint a un canal nomme", () => {
    const result = searchMessages(driver, "reunion in:tech-archi");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items.map((m) => m.pid)).toEqual([id("b", 1)]);
  });

  it("restreint a un auteur", () => {
    const result = searchMessages(driver, "in:general from:bob");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items.map((m) => m.pid)).toEqual([id("a", 3)]);
  });

  it("trouve par hashtag sans le confondre avec le mot", () => {
    const result = searchMessages(driver, "#suivi-projet");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items.map((m) => m.pid)).toEqual([id("a", 3)]);
  });

  it("dit qu un canal est introuvable au lieu d elargir la recherche", () => {
    expect(searchMessages(driver, "reunion in:nexiste-pas")).toEqual({
      kind: "introuvable",
      names: ["nexiste-pas"],
    });
  });

  it("refuse une recherche sans terme positif", () => {
    expect(searchMessages(driver, "-reunion")).toEqual({ kind: "sans-terme-positif" });
  });

  it("ne renvoie rien sur une saisie vide", () => {
    expect(searchMessages(driver, "   ")).toEqual({ kind: "vide" });
  });
});

describe("bornes de dates", () => {
  it("convertit un instant en rowid par dichotomie", () => {
    const first = rowidAtOrAfter(datedDriver, Date.UTC(2026, 0, 1));
    expect(first).toBe(1);
    // Un instant posterieur au dernier message donne le rowid suivant le
    // dernier, ce qui rend la borne haute exclusive utilisable telle quelle.
    const past = rowidAtOrAfter(datedDriver, Date.UTC(2030, 0, 1));
    expect(past).toBe(DAYS + 1);
  });

  it("limite une recherche a un jour", () => {
    const result = searchMessages(datedDriver, "message on:2026-01-05");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items).toHaveLength(1);
    expect(result.page.items[0]?.createAt).toBe(Date.UTC(2026, 0, 5, 12, 0, 0));
  });

  it("exclut le jour cite pour after: et before:", () => {
    const after = searchMessages(datedDriver, "message after:2026-01-05");
    if (after.kind !== "ok") throw new Error(after.kind);
    const oldest = after.page.items.at(-1);
    expect(oldest?.createAt).toBeGreaterThan(Date.UTC(2026, 0, 5, 23, 59));

    const before = searchMessages(datedDriver, "message before:2026-01-05", { limit: 500 });
    if (before.kind !== "ok") throw new Error(before.kind);
    expect(before.page.items.every((m) => m.createAt < Date.UTC(2026, 0, 5))).toBe(true);
  });

  it("croise une fenetre temporelle et un canal", () => {
    const result = searchMessages(datedDriver, "message in:general after:2026-01-01", {
      limit: 500,
    });
    if (result.kind !== "ok") throw new Error(result.kind);
    const channelId = getChannelByName(datedDriver, "general")?.id;
    expect(result.page.items.every((m) => m.channelId === channelId)).toBe(true);
    expect(result.page.items.every((m) => m.createAt > Date.UTC(2026, 0, 1, 23, 59))).toBe(true);
  });

  it("accepte une fenetre temporelle sans aucun mot", () => {
    const result = searchMessages(datedDriver, "on:2026-01-05");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items).toHaveLength(1);
  });

  it("decale les bornes selon le fuseau du lecteur", () => {
    // Les messages sont ecrits a 12h00 UTC : un decalage de treize heures fait
    // basculer celui du 5 janvier sur la journee du 6 pour le lecteur.
    const result = searchMessages(datedDriver, "on:2026-01-06", {
      timeZoneOffsetMinutes: 13 * 60,
    });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.page.items[0]?.createAt).toBe(Date.UTC(2026, 0, 5, 12, 0, 0));
  });
});

describe("ouverture de l index", () => {
  it("refuse un index construit par une version anterieure du schema", async () => {
    // Un index d une version precedente s ouvre sans erreur mais lui manque une
    // table : sans ce controle, la panne surgit bien plus tard, sous la forme
    // d une erreur SQL que personne ne peut relier a la cause.
    const ancien = join(workDir, "ancien.db");
    await copyFile(join(workDir, "index.db"), ancien);
    const db = new DatabaseSync(ancien);
    db.exec("UPDATE meta SET value = '1' WHERE key = 'index_schema_version'");
    db.close();
    expect(() => new NodeSqlDriver(ancien)).toThrow(/version/);
  });

  it("refuse un fichier qui n est pas un index mmarchive", async () => {
    const bogus = join(workDir, "bogus.db");
    await rm(bogus, { force: true });
    expect(() => new NodeSqlDriver(bogus)).toThrow(IndexReadError);
  });
});
