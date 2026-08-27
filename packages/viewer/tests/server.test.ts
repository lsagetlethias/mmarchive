import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/index/build.js";
import type { SqlDriver } from "../src/query/driver.js";
import { NodeSqlDriver } from "../src/query/node-driver.js";
import { createServer } from "../src/server/app.js";
import {
  ALICE,
  CHANNEL_A,
  FILE_KEPT,
  FILE_SKIPPED,
  id,
  PDF_BYTES,
  writeArchive,
} from "./helpers/archive.js";

let workDir: string;
let archiveDir: string;
let indexPath: string;
let driver: SqlDriver;
let app: FastifyInstance;

function body(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-server-"));
  archiveDir = join(workDir, "archive");
  indexPath = join(workDir, "index.db");
  await writeArchive(archiveDir);
  await buildIndex({ archiveRoot: archiveDir, output: indexPath });
  driver = new NodeSqlDriver(indexPath);
  app = createServer({ driver, archiveRoot: archiveDir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  driver.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("lecture seule", () => {
  it("refuse toute methode autre que GET et HEAD", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/channels" });
      expect(response.statusCode, `${method} accepte`).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
    }
  });

  it("refuse une ecriture meme sur une route inexistante", async () => {
    const response = await app.inject({ method: "POST", url: "/api/nexiste-pas" });
    expect(response.statusCode).toBe(405);
  });

  it("n enregistre aucune route d ecriture", () => {
    // Le garde-fou d execution ne suffit pas : cette verification interdit qu une
    // route d ecriture soit ajoutee un jour sans que personne ne le remarque.
    const declared = app.printRoutes({ commonPrefix: false });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(declared, `route ${method} declaree`).not.toContain(method);
    }
  });

  it("accepte HEAD comme GET", async () => {
    const response = await app.inject({ method: "HEAD", url: "/api/channels" });
    expect(response.statusCode).toBe(200);
  });
});

describe("api de lecture", () => {
  it("expose les canaux", async () => {
    const response = await app.inject("/api/channels");
    expect(response.statusCode).toBe(200);
    const channels = body(response.payload).channels as { name: string }[];
    expect(channels.map((c) => c.name)).toEqual(["general", "tech-archi"]);
  });

  it("rend une page de messages avec ses reactions et ses pieces jointes", async () => {
    const channels = body((await app.inject("/api/channels")).payload).channels as { id: number }[];
    const response = await app.inject(`/api/channels/${String(channels[0]?.id)}/messages`);
    const payload = body(response.payload);
    expect((payload.messages as unknown[]).length).toBe(3);
    // Les trois arrivent ensemble : sans cela le client ferait un appel par
    // message pour afficher une seule page.
    expect((payload.reactions as unknown[]).length).toBe(2);
    expect((payload.attachments as unknown[]).length).toBe(2);
  });

  it("pagine par curseur", async () => {
    const channels = body((await app.inject("/api/channels")).payload).channels as { id: number }[];
    const first = body(
      (await app.inject(`/api/channels/${String(channels[0]?.id)}/messages?limit=2`)).payload,
    );
    expect(first.nextCursor).toBeTypeOf("number");
    const next = body(
      (
        await app.inject(
          `/api/channels/${String(channels[0]?.id)}/messages?limit=2&before=${String(first.nextCursor)}`,
        )
      ).payload,
    );
    expect((next.messages as { id: number }[])[0]?.id).toBeLessThan(Number(first.nextCursor));
  });

  it("resout un permalien Mattermost", async () => {
    const response = await app.inject(`/api/permalink/${id("a", 3)}`);
    expect(response.statusCode).toBe(200);
    const message = body(response.payload).message as { message: string };
    expect(message.message).toBe("note de cadrage a relire");
  });

  it("dit clairement qu un permalien ne figure pas dans l archive", async () => {
    const response = await app.inject(`/api/permalink/${id("z", 1)}`);
    expect(response.statusCode).toBe(404);
  });

  it("annonce une reponse dont la racine est absente de l archive", async () => {
    // Sans ce drapeau, ce message s afficherait comme un message ordinaire alors
    // qu il est la suite d une conversation que l archive ne contient pas.
    const orphan = body((await app.inject(`/api/permalink/${id("b", 2)}`)).payload).message as {
      orphanRoot: boolean;
      rootId: number | null;
    };
    expect(orphan.orphanRoot).toBe(true);
    expect(orphan.rootId).toBeNull();

    const root = body((await app.inject(`/api/permalink/${id("a", 1)}`)).payload).message as {
      orphanRoot: boolean;
    };
    expect(root.orphanRoot).toBe(false);
  });

  it("cherche et rend le meme format qu une page de canal", async () => {
    const response = await app.inject("/api/search?q=reunion");
    const payload = body(response.payload);
    expect(payload.status).toBe("ok");
    expect((payload.messages as unknown[]).length).toBe(2);
  });

  it("rapporte un filtre introuvable plutot que d elargir la recherche", async () => {
    const payload = body((await app.inject("/api/search?q=reunion in:absent")).payload);
    expect(payload.status).toBe("introuvable");
    expect(payload.names).toEqual(["absent"]);
  });

  it("rejette une taille de page hors bornes en 400, pas en 500", async () => {
    const response = await app.inject("/api/channels/1/messages?limit=100000");
    expect(response.statusCode).toBe(400);
    expect(body(response.payload).detail).toContain("limit");
  });

  it("rend 404 sur un canal inconnu", async () => {
    expect((await app.inject("/api/channels/99999")).statusCode).toBe(404);
  });
});

describe("service des fichiers de tiers", () => {
  it("sert une piece jointe en telechargement force", async () => {
    const response = await app.inject(`/files/${FILE_KEPT}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain('filename="cadrage.pdf"');
    // Sans nosniff, un fichier televerse peut etre interprete autrement
    // qu annonce, dans l origine du viewer.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.length).toBe(PDF_BYTES.length);
  });

  it("repond aux requetes par plage", async () => {
    const response = await app.inject({
      url: `/files/${FILE_KEPT}`,
      headers: { range: "bytes=0-9" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 0-9/${String(PDF_BYTES.length)}`);
    expect(response.rawPayload.length).toBe(10);
  });

  it("revalide avec un ETag", async () => {
    const first = await app.inject(`/files/${FILE_KEPT}`);
    const etag = first.headers.etag;
    expect(etag).toBeTypeOf("string");
    const second = await app.inject({
      url: `/files/${FILE_KEPT}`,
      headers: { "if-none-match": String(etag) },
    });
    // Sans 304, chaque rechargement retransmettrait l integralite des pieces
    // jointes : c est le premier poste de bande passante du mode full.
    expect(second.statusCode).toBe(304);
  });

  it("annonce une piece jointe non archivee avec sa raison", async () => {
    const response = await app.inject(`/files/${FILE_SKIPPED}`);
    expect(response.statusCode).toBe(410);
    expect(body(response.payload).reason).toBe("too_large");
  });

  it("sert un avatar et un emoji", async () => {
    expect((await app.inject(`/avatars/${ALICE}`)).statusCode).toBe(200);
    expect((await app.inject("/emoji/perroquet")).statusCode).toBe(200);
  });

  it("rend 404 sur une piece jointe inconnue", async () => {
    expect((await app.inject("/files/inconnu")).statusCode).toBe(404);
  });

  it("encode un nom de fichier accentue selon la RFC 5987", async () => {
    const db = new DatabaseSync(indexPath);
    db.exec(`UPDATE file SET name = 'compte rendu réunion; v2.pdf' WHERE fid = '${FILE_KEPT}'`);
    db.close();
    const local = new NodeSqlDriver(indexPath);
    const server = createServer({ driver: local, archiveRoot: archiveDir });
    const response = await server.inject(`/files/${FILE_KEPT}`);
    const disposition = String(response.headers["content-disposition"]);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain("r%C3%A9union");
    // Le repli ASCII ne doit contenir ni point virgule ni guillemet, sous peine
    // de couper l en-tete en deux parametres.
    const fallback = /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
    expect(fallback).not.toContain(";");
    await server.close();
    local.close();
  });
});

describe("racine de l archive", () => {
  it("accepte une racine relative", async () => {
    // @fastify/static exige une racine absolue, alors que la ligne de commande
    // recoit naturellement "./archive".
    const local = new NodeSqlDriver(indexPath);
    const relative = relativePath(process.cwd(), archiveDir);
    const server = createServer({ driver: local, archiveRoot: relative });
    await server.ready();
    expect((await server.inject(`/files/${FILE_KEPT}`)).statusCode).toBe(200);
    await server.close();
    local.close();
  });
});

describe("chemins hors de l archive", () => {
  it("refuse un chemin qui remonte hors de la racine", async () => {
    // Les chemins servis viennent de l archive, donc de donnees produites par
    // des tiers : un chemin remontant ferait du viewer un lecteur de fichiers
    // arbitraires.
    const db = new DatabaseSync(indexPath);
    db.exec(`UPDATE file SET path = '../../../etc/passwd' WHERE fid = '${FILE_KEPT}'`);
    db.close();
    const local = new NodeSqlDriver(indexPath);
    const server = createServer({ driver: local, archiveRoot: archiveDir });
    const response = await server.inject(`/files/${FILE_KEPT}`);
    expect(response.statusCode).toBe(403);
    await server.close();
    local.close();
  });

  it("n expose pas les fichiers bruts de l archive", async () => {
    for (const path of [
      "/manifest.json",
      "/users.ndjson",
      `/posts/${CHANNEL_A}.ndjson`,
      "/.extract-state.json",
    ]) {
      const response = await app.inject(path);
      expect(response.statusCode, `${path} servi`).toBe(404);
    }
  });
});
