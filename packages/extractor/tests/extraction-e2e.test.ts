import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Manifest, SelectionFile } from "@mmarchive/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOptions } from "../src/config/options.js";
import { runExtraction } from "../src/extract/orchestrator.js";
import { MattermostApi } from "../src/mattermost/api.js";
import { MattermostClient } from "../src/mattermost/http-client.js";
import { Logger } from "../src/ui/logger.js";
import { RunReporter } from "../src/ui/run-reporter.js";
import { verifyArchive } from "../src/verify/checks.js";

/** L URL d une requete fetch, quelle que soit la forme de son premier argument. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const CHANNEL_ID = "c".repeat(26);
const TEAM_ID = "t".repeat(26);
const SELF_ID = "u".repeat(26);
const OTHER_ID = "v".repeat(26);
const FILE_ID = "f".repeat(26);
/** Declare public par le fichier de selection, prive sur l instance. */
const MENTEUR_ID = "m".repeat(26);

const TOTAL_POSTS = 250;
const PAGE_SIZE = 200;

/** Posts du plus RECENT au plus ANCIEN, comme les rend l API. */
function allPostsNewestFirst(): Record<string, unknown>[] {
  return Array.from({ length: TOTAL_POSTS }, (_, index) => {
    const age = index;
    const id = `p${String(TOTAL_POSTS - age).padStart(25, "0")}`;
    return {
      id,
      create_at: 1_700_000_000_000 - age * 1000,
      update_at: 1_700_000_000_000 - age * 1000,
      edit_at: 0,
      delete_at: 0,
      user_id: age % 2 === 0 ? SELF_ID : OTHER_ID,
      channel_id: CHANNEL_ID,
      root_id: "",
      message: `message ${String(age)} avec des accents et un emoji`,
      type: "",
      hashtags: "",
      props: {},
      file_ids: age === 0 ? [FILE_ID] : [],
      metadata:
        age === 0
          ? {
              reactions: [
                { user_id: OTHER_ID, post_id: id, emoji_name: "+1", create_at: 1_700_000_000_000 },
              ],
              files: [
                {
                  id: FILE_ID,
                  user_id: SELF_ID,
                  post_id: id,
                  create_at: 1_700_000_000_000,
                  update_at: 0,
                  delete_at: 0,
                  name: "compte rendu.pdf",
                  extension: "pdf",
                  size: 12,
                  mime_type: "application/pdf",
                  width: 0,
                  height: 0,
                  has_preview_image: false,
                },
              ],
            }
          : { reactions: null, files: null },
    };
  });
}

interface Recorded {
  readonly method: string;
  readonly path: string;
}

function makeServer(): { fetchImpl: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const posts = allPostsNewestFirst();

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    const path = url.pathname.replace("/api/v4", "");
    requests.push({ method: init?.method ?? "GET", path });

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-version-id": "9.5.2" },
      });

    if (path === "/users/me") return json({ id: SELF_ID, username: "alice", roles: "system_user" });
    if (path === "/system/ping") return json({ status: "OK" });
    if (path === `/channels/${CHANNEL_ID}/pinned`) return json({ order: [], posts: {} });
    // Fiches relues avant d extraire : `header`, `purpose` et `create_at` cote
    // canal, `description`, `type` et `create_at` cote team, aucun de ces champs
    // ne transitant par le fichier de selection.
    if (path === `/channels/${CHANNEL_ID}`) {
      return json({
        id: CHANNEL_ID,
        type: "O",
        name: "town-square",
        display_name: "Town Square",
        header: "Contact : equipe produit",
        purpose: "Discussions generales de l equipe",
        create_at: 1_600_000_000_000,
        delete_at: 0,
      });
    }
    if (path === `/channels/${MENTEUR_ID}`) {
      return json({ id: MENTEUR_ID, type: "P", name: "prive", display_name: "Prive" });
    }
    if (path === `/channels/${MENTEUR_ID}/posts` || path === `/channels/${MENTEUR_ID}/pinned`) {
      // Le simulateur accepte de les servir : c est a l outil de ne pas demander.
      return json({ order: [], posts: {} });
    }
    if (path === `/teams/${TEAM_ID}`) {
      return json({
        id: TEAM_ID,
        name: "produit",
        display_name: "Produit",
        description: "L equipe produit",
        type: "O",
        create_at: 1_500_000_000_000,
        delete_at: 0,
      });
    }
    if (path === "/emoji") {
      return json(
        url.searchParams.get("page") === "0"
          ? [
              {
                id: "e".repeat(26),
                name: "parrot",
                creator_id: SELF_ID,
                create_at: 1,
                update_at: 1,
                delete_at: 0,
              },
            ]
          : [],
      );
    }

    if (path === `/channels/${CHANNEL_ID}/posts`) {
      const before = url.searchParams.get("before");
      let start = 0;
      if (before !== null) {
        const index = posts.findIndex((post) => post.id === before);
        // L API renvoie le pivot inclus : c est le cas le plus hostile pour la
        // deduplication, on le simule volontairement.
        start = index < 0 ? 0 : index;
      }
      const slice = posts.slice(start, start + PAGE_SIZE);
      const map: Record<string, unknown> = {};
      for (const post of slice) map[String(post.id)] = post;
      return json({ order: slice.map((p) => String(p.id)), posts: map });
    }

    if (path === "/users/ids") {
      return json([
        { id: SELF_ID, username: "alice", roles: "system_user", delete_at: 0 },
        { id: OTHER_ID, username: "bob", roles: "system_user", delete_at: 1_600_000_000_000 },
      ]);
    }
    if (path.endsWith("/image")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (path === `/files/${FILE_ID}`) {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return json({ message: `route non simulee: ${path}` }, 404);
  };

  return { fetchImpl, requests };
}

function selectionFor(out: string): SelectionFile {
  return {
    meta: {
      generated_at: "2026-08-24T10:00:00.000Z",
      tool_version: "0.1.0",
      source_url: out,
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

/** Selection ou un canal prive a ete maquille en public a la main. */
function selectionMenteuse(out: string): SelectionFile {
  const base = selectionFor(out);
  const team = base.teams[0];
  if (team === undefined) throw new Error("selection de test malformee");
  return {
    ...base,
    teams: [
      {
        ...team,
        channels: [
          ...team.channels,
          {
            id: MENTEUR_ID,
            name: "prive",
            display_name: "Prive",
            type: "O",
            joined: true,
            archived: false,
            message_count: 10,
            selected: true,
          },
        ],
      },
    ],
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-e2e-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function extract(over: Partial<RunOptions> = {}, selection?: SelectionFile) {
  const { fetchImpl, requests } = makeServer();
  const client = new MattermostClient({
    baseUrl: "https://mm.example.org",
    token: "secret",
    rateLimit: 1000,
    sleep: () => Promise.resolve(),
    fetchImpl,
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
    resume: false,
    skipFiles: false,
    maxFileSizeBytes: 100 * 1024 * 1024,
    includeEmails: false,
    concurrency: 1,
    rateLimit: 8,
    postsPageSize: PAGE_SIZE,
    ...over,
  };

  const manifest = await runExtraction({
    api,
    client,
    account,
    runOptions,
    selection: selection ?? selectionFor("https://mm.example.org"),
    selectionMode: "file",
    totalPublicChannels: 1,
    logger: new Logger({ level: "error" }),
    confirmJoins: () => Promise.resolve(false),
    reporter: silentReporter(),
    clock: () => "2026-08-24T10:00:00.000Z",
  });

  return { manifest, requests };
}

async function readPosts(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(workDir, "posts", `${CHANNEL_ID}.ndjson`), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readNdjson(fichier: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(workDir, fichier), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

describe("extraction de bout en bout", () => {
  it("n emet aucune requete d ecriture quand aucun join n est necessaire", async () => {
    // Verification defensive numero 3, sur le chemin complet du run.
    const { requests } = await extract();
    const writes = requests.filter(
      (request) => request.method !== "GET" && request.path !== "/users/ids",
    );
    expect(writes).toEqual([]);
  });

  it("decrit le canal avec son en-tete, son objet et sa date de creation", async () => {
    // Ces trois champs etaient ecrits en dur a la chaine vide et a zero : ils
    // sont relus au moment d ecrire, et perdus pour toujours une fois l instance
    // eteinte si personne ne les demande.
    await extract();
    const [canal] = await readNdjson("channels.ndjson");
    expect(canal).toMatchObject({
      header: "Contact : equipe produit",
      purpose: "Discussions generales de l equipe",
      create_at: 1_600_000_000_000,
    });
  });

  it("decrit la team avec sa description, son type et sa date de creation", async () => {
    await extract();
    const [team] = await readNdjson("teams.ndjson");
    expect(team).toMatchObject({
      description: "L equipe produit",
      type: "O",
      create_at: 1_500_000_000_000,
    });
  });

  it("ne lit aucun message d un canal que l instance ne donne pas pour public", async () => {
    // Le fichier de selection est editable a la main, et buildPlan ne peut
    // verifier que ce qu il declare. Seule l instance sait. La fiche est donc
    // relue AVANT le premier message : un controle en fin de course arriverait
    // apres l ecriture.
    const { manifest, requests } = await extract({}, selectionMenteuse("https://mm.example.org"));
    const lectures = requests.filter((r) => r.path.startsWith(`/channels/${MENTEUR_ID}/`));
    expect(lectures).toEqual([]);
    expect(existsSync(join(workDir, "posts", `${MENTEUR_ID}.ndjson`))).toBe(false);
    const canaux = await readNdjson("channels.ndjson");
    expect(canaux.map((c) => c.id)).toEqual([CHANNEL_ID]);
    expect(manifest.warnings.map((w) => w.code)).toContain("NON_PUBLIC_CHANNEL_REJECTED");
  });

  it("ecrit tous les messages, sans doublon malgre un pivot inclusif", async () => {
    await extract();
    const posts = await readPosts();
    expect(posts).toHaveLength(TOTAL_POSTS);
    expect(new Set(posts.map((p) => p.id)).size).toBe(TOTAL_POSTS);
  });

  it("trie les messages par create_at croissant, comme l impose le format", async () => {
    // L API pagine du plus recent au plus ancien : c est l inversion finale du
    // fichier .part qui produit cet ordre.
    const posts = await extract().then(readPosts);
    const dates = posts.map((p) => p.create_at as number);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(dates[0]).toBeLessThan(dates[dates.length - 1]!);
  });

  it("ne laisse aucun fichier de travail .part derriere lui", async () => {
    await extract();
    const files = await readdir(join(workDir, "posts"));
    expect(files.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("conserve les reactions et les messages non ASCII", async () => {
    const posts = await extract().then(readPosts);
    const withReaction = posts.find((p) => (p.reactions as unknown[]).length > 0);
    expect(withReaction).toBeDefined();
    expect(posts[0]?.message).toContain("accents");
  });

  it("archive la piece jointe et conserve son nom d origine", async () => {
    await extract();
    const files = (await readFile(join(workDir, "files.ndjson"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("compte rendu.pdf");
    expect(files[0]?.path).toContain("attachments/");
    expect(files[0]?.skip_reason).toBeUndefined();
  });

  it("conserve la metadonnee d une piece jointe non telechargee", async () => {
    await extract({ skipFiles: true });
    const files = (await readFile(join(workDir, "files.ndjson"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(files[0]?.path).toBeNull();
    expect(files[0]?.skip_reason).toBe("skipped_by_option");
  });

  it("conserve les comptes desactives", async () => {
    await extract();
    const users = (await readFile(join(workDir, "users.ndjson"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const bob = users.find((u) => u.username === "bob");
    expect(bob?.delete_at).not.toBe(0);
  });

  it("n inclut aucune adresse e-mail par defaut", async () => {
    await extract();
    const text = await readFile(join(workDir, "users.ndjson"), "utf8");
    expect(text).not.toContain("email");
  });

  it("s arrete a la borne --since sans utiliser le parametre since de l API", async () => {
    // Le parametre since de l API selectionne les posts MODIFIES et interdit la
    // pagination : la borne est donc appliquee cote client.
    const cutoff = 1_700_000_000_000 - 50 * 1000;
    const { manifest, requests } = await extract({ since: cutoff });
    const posts = await readPosts();
    expect(posts.length).toBeLessThan(TOTAL_POSTS);
    expect(posts.every((p) => (p.create_at as number) >= cutoff)).toBe(true);
    expect(manifest.options.since).toBe(new Date(cutoff).toISOString());
    expect(requests.some((r) => r.path.includes("since="))).toBe(false);
  });

  it("compte les emojis personnalises dans le manifeste", async () => {
    // Le compteur etait code en dur a zero : releve sur une archive reelle ou
    // 762 emojis avaient bien ete extraits mais n apparaissaient nulle part.
    const { manifest } = await extract();
    expect(manifest.counts.emojis).toBe(1);
    const lines = (await readFile(join(workDir, "emojis.ndjson"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(manifest.counts.emojis).toBe(lines.length);
  });

  it("l archive produite passe sa propre verification", async () => {
    // Le run verifie desormais son resultat : une archive incoherente doit etre
    // detectee tout de suite, pas des jours plus tard quand l instance a
    // disparu et que plus rien n est rejouable.
    const { manifest } = await extract();
    // runExtraction rend le manifeste, c est la commande qui l ecrit.
    await writeFile(join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const report = await verifyArchive({ archiveDir: workDir, checkBlobs: true });
    const failures = report.results.filter((r) => r.severity === "error");
    expect(failures.map((r) => `${r.label} ${r.detail ?? ""}`)).toEqual([]);
    expect(report.errors).toBe(0);
  });

  it("produit un manifeste coherent et auditable", async () => {
    const { manifest } = await extract();
    const parsed: Manifest = manifest;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.counts.posts).toBe(TOTAL_POSTS);
    expect(parsed.counts.channels).toBe(1);
    expect(parsed.counts.users).toBe(2);
    expect(parsed.counts.attachments).toBe(1);
    expect(parsed.selection.channels_joined_by_tool).toBe(0);
    expect(parsed.joined_channels).toEqual([]);
    expect(parsed.post_range?.first_create_at).toBeLessThan(parsed.post_range?.last_create_at ?? 0);
  });
});
