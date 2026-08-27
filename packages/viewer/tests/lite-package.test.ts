import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex } from "../src/index/build.js";
import type { SqlDriver } from "../src/query/driver.js";
import { NodeSqlDriver } from "../src/query/node-driver.js";
import { createServer } from "../src/server/app.js";
import { planLitePackage, streamLitePackage } from "../src/server/lite-package.js";
import { writeArchive } from "./helpers/archive.js";

let workDir: string;
let archiveDir: string;
let indexPath: string;
let webRoot: string;
let standalonePath: string;
let driver: SqlDriver;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-lite-"));
  archiveDir = join(workDir, "archive");
  indexPath = join(workDir, "index.db");
  webRoot = join(workDir, "web");
  standalonePath = join(workDir, "archive.html");

  await writeArchive(archiveDir);
  await buildIndex({ archiveRoot: archiveDir, output: indexPath });
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>x</title>", "utf8");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log(1)", "utf8");
  await writeFile(standalonePath, "<!doctype html><title>autonome</title>", "utf8");
  driver = new NodeSqlDriver(indexPath);
});

afterEach(async () => {
  driver.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("plan de la copie autonome", () => {
  it("recense l index, le fichier unique et le frontend", async () => {
    const plan = await planLitePackage({ indexPath, webRoot, standalonePath });
    const cibles = plan.entries.map((entry) => entry.target).sort();
    expect(cibles).toEqual(["archive.html", "index.db", "web/assets/app.js", "web/index.html"]);
    expect(plan.missing).toEqual([]);
    expect(plan.rawBytes).toBeGreaterThan(0);
  });

  it("utilise des separateurs de chemin de zip, jamais ceux du systeme", async () => {
    const plan = await planLitePackage({ indexPath, webRoot, standalonePath });
    for (const entry of plan.entries) expect(entry.target).not.toContain("\\");
  });

  it("signale ce qui manque plutot que de produire une copie muette", async () => {
    const plan = await planLitePackage({
      indexPath: join(workDir, "absent.db"),
      webRoot: undefined,
      standalonePath: undefined,
    });
    expect([...plan.missing].sort()).toEqual(["archive.html", "index.db", "web/"]);
    expect(plan.entries).toEqual([]);
  });
});

describe("assemblage de la copie", () => {
  it("produit une archive zip lisible, avec sa notice", async () => {
    const plan = await planLitePackage({ indexPath, webRoot, standalonePath });
    const zip = await collect(streamLitePackage(plan));

    // Signature d une entree locale de fichier zip.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const texte = zip.toString("latin1");
    for (const nom of ["index.db", "archive.html", "web/index.html", "LISEZMOI.txt"]) {
      expect(texte, `${nom} absent de l archive`).toContain(nom);
    }
  });

  it("compresse, au lieu de recopier tel quel", async () => {
    const plan = await planLitePackage({ indexPath, webRoot, standalonePath });
    const zip = await collect(streamLitePackage(plan));
    expect(zip.length).toBeLessThan(plan.rawBytes);
  });
});

describe("routes de la copie", () => {
  async function server(complete: boolean): Promise<FastifyInstance> {
    const app = createServer({
      driver,
      archiveRoot: archiveDir,
      indexPath,
      ...(complete ? { webRoot, standalonePath } : {}),
    });
    await app.ready();
    return app;
  }

  it("annonce la copie et sa taille avant de la produire", async () => {
    // Le telechargement se compte en centaines de megaoctets : l annoncer evite
    // de le lancer a l aveugle.
    const app = await server(true);
    const body = JSON.parse((await app.inject("/api/lite")).payload) as {
      disponible: boolean;
      octets: number;
      fichiers: number;
    };
    expect(body.disponible).toBe(true);
    expect(body.fichiers).toBe(4);
    expect(body.octets).toBeGreaterThan(0);
    await app.close();
  });

  it("refuse de produire une copie incomplete", async () => {
    const app = await server(false);
    const response = await app.inject("/lite.zip");
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload)).toMatchObject({
      manquant: expect.arrayContaining(["archive.html"]),
    });
    await app.close();
  });

  it("sert la copie en telechargement", async () => {
    const app = await server(true);
    const response = await app.inject("/lite.zip");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toContain("archive-mmarchive.zip");
    expect(response.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
    await app.close();
  });

  it("reste en lecture seule sur ces routes aussi", async () => {
    const app = await server(true);
    expect((await app.inject({ method: "POST", url: "/lite.zip" })).statusCode).toBe(405);
    await app.close();
  });
});
