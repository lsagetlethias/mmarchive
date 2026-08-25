import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { SelectionFile } from "@mmarchive/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOptions } from "../src/config/options.js";
import { runExtraction } from "../src/extract/orchestrator.js";
import { MattermostApi } from "../src/mattermost/api.js";
import { MattermostClient } from "../src/mattermost/http-client.js";
import { Logger } from "../src/ui/logger.js";
import { RunReporter } from "../src/ui/run-reporter.js";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const CHANNEL_ID = "c".repeat(26);
const TEAM_ID = "t".repeat(26);
const SELF_ID = "u".repeat(26);
const TOTAL_POSTS = 450;
const PAGE_SIZE = 200;

function allPostsNewestFirst(): Record<string, unknown>[] {
  return Array.from({ length: TOTAL_POSTS }, (_, age) => ({
    id: `p${String(TOTAL_POSTS - age).padStart(25, "0")}`,
    create_at: 1_700_000_000_000 - age * 1000,
    update_at: 1_700_000_000_000 - age * 1000,
    edit_at: 0,
    delete_at: 0,
    user_id: SELF_ID,
    channel_id: CHANNEL_ID,
    root_id: "",
    message: `message ${String(age)}`,
    type: "",
    hashtags: "",
    props: {},
    file_ids: [],
    metadata: { reactions: null, files: null },
  }));
}

/** failAfterPages: nombre de pages servies avant que le serveur ne tombe. */
function makeServer(failAfterPages: number): typeof fetch {
  const posts = allPostsNewestFirst();
  let pagesServed = 0;

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    const path = url.pathname.replace("/api/v4", "");
    void init;

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-version-id": "10.12.4" },
      });

    if (path === "/users/me") return json({ id: SELF_ID, username: "alice", roles: "system_user" });
    if (path === "/system/ping") return json({ status: "OK" });
    if (path === `/channels/${CHANNEL_ID}/pinned`) return json({ order: [], posts: {} });
    if (path === "/emoji") return json([]);
    if (path === "/users/ids") return json([{ id: SELF_ID, username: "alice", delete_at: 0 }]);
    if (path.endsWith("/image")) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (path === `/channels/${CHANNEL_ID}/posts`) {
      if (pagesServed >= failAfterPages) {
        // Panne franche et persistante, comme une coupure reseau en pleine nuit.
        return json({ message: "boom" }, 500);
      }
      pagesServed += 1;
      const before = url.searchParams.get("before");
      let start = 0;
      if (before !== null) {
        const index = posts.findIndex((post) => post.id === before);
        start = index < 0 ? 0 : index;
      }
      const slice = posts.slice(start, start + PAGE_SIZE);
      const map: Record<string, unknown> = {};
      for (const post of slice) map[String(post.id)] = post;
      return json({ order: slice.map((p) => String(p.id)), posts: map });
    }
    return json({ message: `route non simulee: ${path}` }, 404);
  };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-resume-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function selection(): SelectionFile {
  return {
    meta: {
      generated_at: "2026-08-24T10:00:00.000Z",
      tool_version: "0.1.0",
      source_url: "https://mm.example.org",
      account: { user_id: SELF_ID, username: "alice", is_system_admin: false },
    },
    teams: [
      {
        id: TEAM_ID,
        name: "produit",
        display_name: "Produit",
        joined: true,
        channels: [
          {
            id: CHANNEL_ID,
            name: "town-square",
            display_name: "Town Square",
            type: "O",
            joined: true,
            archived: false,
            message_count: TOTAL_POSTS,
            selected: true,
          },
        ],
      },
    ],
  };
}

async function extractOnce(failAfterPages: number, resume: boolean) {
  const client = new MattermostClient({
    baseUrl: "https://mm.example.org",
    token: "secret",
    rateLimit: 1000,
    maxRetries: 0,
    sleep: () => Promise.resolve(),
    fetchImpl: makeServer(failAfterPages),
  });
  const api = new MattermostApi(client);
  const account = await api.getMe();
  const runOptions: RunOptions = {
    connection: { url: "https://mm.example.org", token: "secret" },
    file: undefined,
    out: workDir,
    yes: true,
    joinTeams: false,
    leaveAfter: false,
    since: undefined,
    resume,
    skipFiles: false,
    maxFileSizeBytes: 100 * 1024 * 1024,
    includeEmails: false,
    concurrency: 1,
    rateLimit: 8,
    postsPageSize: PAGE_SIZE,
  };
  return runExtraction({
    api,
    client,
    account,
    runOptions,
    selection: selection(),
    selectionMode: "file",
    totalPublicChannels: 1,
    logger: new Logger({ level: "error" }),
    confirmJoins: () => Promise.resolve(false),
    reporter: silentReporter(),
    clock: () => "2026-08-24T10:00:00.000Z",
  });
}

async function readPosts(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(workDir, "posts", `${CHANNEL_ID}.ndjson`), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reporter muet : les tests ne doivent rien ecrire sur la sortie standard. */
function silentReporter(): RunReporter {
  return new RunReporter({
    estimatedMessages: 0,
    out: new Writable({
      write(_chunk, _enc, cb: () => void) {
        cb();
      },
    }),
    interactive: false,
  });
}

describe("reprise apres interruption", () => {
  it("consigne un avertissement et n annonce pas le canal comme complet", async () => {
    const manifest = await extractOnce(1, false);
    expect(manifest.warnings.some((w) => w.code === "CHANNEL_INCOMPLETE")).toBe(true);
    expect(manifest.counts.channels).toBe(0);
  });

  it("conserve le fichier de travail et le curseur pour pouvoir reprendre", async () => {
    await extractOnce(1, false);
    // Le fichier de travail est <channel_id>.ndjson.part, dans le meme
    // repertoire que le fichier final pour que le remplacement reste atomique.
    expect(await exists(join(workDir, "posts", `${CHANNEL_ID}.ndjson.part`))).toBe(true);

    const state = JSON.parse(await readFile(join(workDir, ".extract-state.json"), "utf8")) as {
      channels: Record<string, { posts_written: number; oldest_post_id: string | null }>;
    };
    const progress = state.channels[CHANNEL_ID];
    expect(progress?.posts_written).toBe(PAGE_SIZE);
    expect(progress?.oldest_post_id).not.toBeNull();
  });

  it("termine l extraction et produit un fichier complet et trie", async () => {
    await extractOnce(1, false);
    const manifest = await extractOnce(99, true);

    const posts = await readPosts();
    expect(posts).toHaveLength(TOTAL_POSTS);
    expect(new Set(posts.map((p) => p.id)).size).toBe(TOTAL_POSTS);

    const dates = posts.map((p) => p.create_at as number);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(manifest.counts.posts).toBe(TOTAL_POSTS);
  });

  it("ne duplique pas les messages deja ecrits avant l interruption", async () => {
    await extractOnce(1, false);
    await extractOnce(99, true);
    const posts = await readPosts();
    const counts = new Map<string, number>();
    for (const post of posts) {
      const id = String(post.id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const duplicated = [...counts.values()].filter((n) => n > 1);
    expect(duplicated).toEqual([]);
  });

  it("nettoie le fichier de travail une fois le canal termine", async () => {
    await extractOnce(1, false);
    await extractOnce(99, true);
    const files = await readdir(join(workDir, "posts"));
    expect(files.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("ne duplique rien quand l etat est en retard sur le fichier de travail", async () => {
    // Scenario d un Ctrl+C : l etat n est sauvegarde qu au plus toutes les cinq
    // secondes, donc le .part peut contenir des pages dont le curseur n a jamais
    // ete enregistre. Repartir du curseur de l etat rejouerait ces pages.
    await extractOnce(1, false);

    const statePath = join(workDir, ".extract-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      channels: Record<string, { posts_written: number; oldest_post_id: string | null }>;
    };
    const progress = state.channels[CHANNEL_ID];
    expect(progress).toBeDefined();

    // On rembobine l etat comme si la derniere sauvegarde n avait pas eu lieu.
    const partLines = (await readFile(join(workDir, "posts", `${CHANNEL_ID}.ndjson.part`), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(partLines.length).toBeGreaterThan(50);
    const rewound = JSON.parse(partLines[49] ?? "{}") as { id: string };
    if (progress) {
      progress.posts_written = 50;
      progress.oldest_post_id = rewound.id;
    }
    await writeFile(statePath, JSON.stringify(state), "utf8");

    await extractOnce(99, true);

    const posts = await readPosts();
    const counts = new Map<string, number>();
    for (const post of posts) {
      const id = String(post.id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.values()].filter((n) => n > 1)).toEqual([]);
    expect(posts).toHaveLength(TOTAL_POSTS);
    const dates = posts.map((p) => p.create_at as number);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("ne detruit pas un canal dont les messages etaient deja finalises", async () => {
    // Regression grave : une interruption entre la finalisation des messages et
    // la fin de leur phase de pieces jointes laissait le canal en in_progress
    // sans fichier de travail. La reprise recreait un .part vide, l inversait,
    // et tronquait a zero un fichier complet, pendant que le manifeste
    // continuait d annoncer le compte d origine.
    await extractOnce(99, false);
    const before = await readPosts();
    expect(before).toHaveLength(TOTAL_POSTS);

    // On rejoue l etat exact d une interruption a ce moment precis.
    const statePath = join(workDir, ".extract-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      channels: Record<string, { status: string; finalized: boolean }>;
    };
    const progress = state.channels[CHANNEL_ID];
    expect(progress?.finalized).toBe(true);
    if (progress) progress.status = "in_progress";
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const manifest = await extractOnce(99, true);

    const after = await readPosts();
    expect(after).toHaveLength(TOTAL_POSTS);
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect(manifest.counts.posts).toBe(TOTAL_POSTS);
  });

  it("annonce dans le manifeste le nombre de messages reellement sur disque", async () => {
    const manifest = await extractOnce(99, false);
    const posts = await readPosts();
    expect(manifest.counts.posts).toBe(posts.length);
  });

  it("survit a deux interruptions successives", async () => {
    await extractOnce(1, false);
    await extractOnce(1, true);
    const manifest = await extractOnce(99, true);
    const posts = await readPosts();
    expect(posts).toHaveLength(TOTAL_POSTS);
    expect(new Set(posts.map((p) => p.id)).size).toBe(TOTAL_POSTS);
    expect(manifest.counts.posts).toBe(TOTAL_POSTS);
  });
});
