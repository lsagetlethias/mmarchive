import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArchivePaths } from "../src/archive/paths.js";
import { extractEmojis, extractFiles, extractUsers } from "../src/extract/assets.js";
import type { MattermostApi } from "../src/mattermost/api.js";
import type { MmFileInfo } from "../src/mattermost/types.js";

const CHANNEL = "c".repeat(26);

function fileInfo(index: number): MmFileInfo {
  return {
    id: `f${String(index).padStart(25, "0")}`,
    user_id: "u".repeat(26),
    post_id: "p".repeat(26),
    create_at: 1,
    update_at: 1,
    delete_at: 0,
    name: `piece-${String(index)}.png`,
    extension: "png",
    size: 10,
    mime_type: "image/png",
    width: 0,
    height: 0,
    has_preview_image: false,
  };
}

/** Api simulee qui mesure combien de telechargements sont en vol simultanement. */
function trackingApi(delayMs = 5) {
  let inFlight = 0;
  let peak = 0;
  const api = {
    downloadFile: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", size: 3 };
    },
  } as unknown as MattermostApi;
  return { api, peak: () => peak };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-assets-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function run(downloadConcurrency: number | undefined, count = 12) {
  const { api, peak } = trackingApi();
  const result = await extractFiles({
    api,
    paths: createArchivePaths(workDir),
    includeEmails: false,
    skipFiles: false,
    maxFileSizeBytes: 1024,
    ...(downloadConcurrency === undefined ? {} : { downloadConcurrency }),
    files: Array.from({ length: count }, (_, i) => fileInfo(i)),
    channelId: CHANNEL,
    alreadyDone: new Set<string>(),
  });
  const lines = (await readFile(join(workDir, "files.ndjson"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, lines, peak: peak() };
}

describe("concurrence des telechargements de pieces jointes", () => {
  it("telecharge un par un par defaut", () => {
    return run(undefined).then(({ peak }) => {
      expect(peak).toBe(1);
    });
  });

  it("mene plusieurs telechargements de front quand on le demande", async () => {
    // Les pieces jointes dominent le nombre de requetes et chacune est bornee
    // par la latence : sans concurrence, le lien reste inutilise.
    const { peak } = await run(4);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("ecrit exactement un enregistrement par fichier, quel que soit le lot", async () => {
    const { result, lines } = await run(4, 10);
    expect(result.downloaded).toBe(10);
    expect(lines).toHaveLength(10);
    expect(new Set(lines.map((l) => l.id)).size).toBe(10);
  });

  it("produit le meme resultat en sequentiel et en concurrent", async () => {
    const sequential = await run(1, 7);
    await rm(join(workDir, "files.ndjson"), { force: true });
    const concurrent = await run(4, 7);
    expect(concurrent.result.downloaded).toBe(sequential.result.downloaded);
    expect(concurrent.lines.map((l) => l.id).sort()).toEqual(
      sequential.lines.map((l) => l.id).sort(),
    );
  });

  it("n ecrit aucun binaire mais garde les metadonnees avec --skip-files", async () => {
    const { api } = trackingApi();
    const result = await extractFiles({
      api,
      paths: createArchivePaths(workDir),
      includeEmails: false,
      skipFiles: true,
      maxFileSizeBytes: 1024,
      downloadConcurrency: 4,
      files: [fileInfo(0), fileInfo(1)],
      channelId: CHANNEL,
      alreadyDone: new Set<string>(),
    });
    expect(result.downloaded).toBe(0);
    expect(result.skipped).toBe(2);
    const lines = (await readFile(join(workDir, "files.ndjson"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.skip_reason).toBe("skipped_by_option");
  });
});

describe("concurrence des emojis et des avatars", () => {
  it("telecharge les emojis de front", async () => {
    // 762 emojis en serie a 80 ms coutent une minute avec une seule requete en
    // vol, alors que le limiteur en autorise quarante.
    let inFlight = 0;
    let peak = 0;
    const api = {
      getCustomEmojis: () =>
        Promise.resolve(
          Array.from({ length: 12 }, (_, i) => ({
            id: `e${String(i).padStart(25, "0")}`,
            name: `emoji-${String(i)}`,
            creator_id: "u".repeat(26),
            create_at: 1,
            update_at: 1,
            delete_at: 0,
          })),
        ),
      downloadEmojiImage: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { bytes: new Uint8Array([1]), contentType: "image/png", size: 1 };
      },
    } as unknown as MattermostApi;

    const result = await extractEmojis({
      api,
      paths: createArchivePaths(workDir),
      includeEmails: false,
      skipFiles: false,
      maxFileSizeBytes: 1024,
      downloadConcurrency: 4,
    });

    expect(result.count).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("associe chaque avatar au bon utilisateur malgre la concurrence", async () => {
    // Les telechargements se terminent dans le desordre : l ecriture doit rester
    // alignee sur l ordre des utilisateurs.
    const api = {
      getUsersByIds: (ids: readonly string[]) =>
        Promise.resolve(
          ids.map((id, i) => ({
            id,
            username: `user-${String(i)}`,
            nickname: "",
            first_name: "",
            last_name: "",
            position: "",
            roles: "system_user",
            create_at: 1,
            delete_at: 0,
          })),
        ),
      downloadAvatar: async (userId: string) => {
        // Les derniers repondent en premier.
        const delay = 20 - Number(userId.slice(-2).replace(/\D/g, "")) * 2;
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
        return { bytes: new Uint8Array([1]), contentType: "image/png", size: 1 };
      },
    } as unknown as MattermostApi;

    const ids = Array.from({ length: 8 }, (_, i) => `u${String(i).padStart(25, "0")}`);
    const result = await extractUsers({
      api,
      paths: createArchivePaths(workDir),
      includeEmails: false,
      skipFiles: false,
      maxFileSizeBytes: 1024,
      downloadConcurrency: 4,
      userIds: new Set(ids),
      alreadyDone: new Set<string>(),
    });

    expect(result.count).toBe(8);
    const lines = (await readFile(join(workDir, "users.ndjson"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      expect(String(line.avatar)).toContain(String(line.id));
    }
  });
});

describe("fenetre glissante contre tranches verrouillees", () => {
  it("garde la concurrence pleine malgre un element tres lent", async () => {
    // Constat mesure sur l archive reelle : avec des tranches successives, un
    // seul fichier de 74 Mo immobilisait les autres connexions du lot, ramenant
    // la concurrence effective de 5 a 1,35.
    let inFlight = 0;
    const samples: number[] = [];
    const api = {
      downloadFile: async (fileId: string) => {
        inFlight += 1;
        samples.push(inFlight);
        // Le premier fichier est cent fois plus lent que les autres.
        const slow = fileId.endsWith("0".repeat(25));
        await new Promise((resolve) => setTimeout(resolve, slow ? 120 : 2));
        inFlight -= 1;
        return { bytes: new Uint8Array([1]), contentType: "image/png", size: 1 };
      },
    } as unknown as MattermostApi;

    const files = Array.from({ length: 40 }, (_, i) => fileInfo(i));
    await extractFiles({
      api,
      paths: createArchivePaths(workDir),
      includeEmails: false,
      skipFiles: false,
      maxFileSizeBytes: 1024,
      downloadConcurrency: 5,
      files,
      channelId: CHANNEL,
      alreadyDone: new Set<string>(),
    });

    // Avec des tranches, la moyenne s effondre pendant l attente du lent.
    const average = samples.reduce((sum, n) => sum + n, 0) / samples.length;
    expect(average).toBeGreaterThan(3);
  });

  it("conserve l ordre des enregistrements malgre les fins desordonnees", async () => {
    const api = {
      downloadFile: async (fileId: string) => {
        const rank = Number(fileId.slice(-2).replace(/\D/g, ""));
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, 20 - rank * 2)));
        return { bytes: new Uint8Array([1]), contentType: "image/png", size: 1 };
      },
    } as unknown as MattermostApi;

    const files = Array.from({ length: 8 }, (_, i) => fileInfo(i));
    await extractFiles({
      api,
      paths: createArchivePaths(workDir),
      includeEmails: false,
      skipFiles: false,
      maxFileSizeBytes: 1024,
      downloadConcurrency: 4,
      files,
      channelId: CHANNEL,
      alreadyDone: new Set<string>(),
    });

    const lines = (await readFile(join(workDir, "files.ndjson"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((l) => l.id)).toEqual(files.map((f) => f.id));
    for (const line of lines) {
      expect(String(line.path)).toContain(String(line.id));
    }
  });
});
