import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pseudonymFor, redactArchive } from "../src/redact/redact-archive.js";
import { Logger } from "../src/ui/logger.js";
import { verifyArchive } from "../src/verify/checks.js";

const TARGET = "t".repeat(26);
const OTHER = "o".repeat(26);
const CHANNEL = "c".repeat(26);
const TEAM = "m".repeat(26);
const FILE_OF_TARGET = "f".repeat(26);

let workDir: string;

/** Chemin et contenu de chaque fichier de l archive, pour comparer avant et apres. */
async function empreinteArchive(): Promise<[string, string][]> {
  const entries = await readdir(workDir, { recursive: true, withFileTypes: true });
  const out: [string, string][] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const chemin = join(entry.parentPath, entry.name);
    out.push([relative(workDir, chemin), await readFile(chemin, "utf8").catch(() => "binaire")]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

const silent = new Logger({ level: "error" });

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `p${String(Math.random()).slice(2, 10).padEnd(25, "0")}`,
    channel_id: CHANNEL,
    user_id: OTHER,
    create_at: 1_700_000_000_000,
    update_at: 1_700_000_000_000,
    edit_at: 0,
    delete_at: 0,
    root_id: "",
    type: "",
    message: "un message",
    is_pinned: false,
    hashtags: "",
    props: {},
    file_ids: [],
    reactions: [],
    ...over,
  };
}

async function writeNdjson(path: string, records: Record<string, unknown>[]): Promise<void> {
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

/** Archive minimale mais complete, pour que verify puisse se prononcer. */
async function buildArchive(): Promise<void> {
  await mkdir(join(workDir, "posts"), { recursive: true });
  await mkdir(join(workDir, "avatars"), { recursive: true });
  await mkdir(join(workDir, "attachments", FILE_OF_TARGET), { recursive: true });

  const posts = [
    post({ id: "p".repeat(26), user_id: TARGET, message: "message de la personne visee" }),
    post({
      id: "q".repeat(26),
      user_id: TARGET,
      file_ids: [FILE_OF_TARGET],
      message: "avec piece jointe",
    }),
    post({
      id: "r".repeat(26),
      user_id: OTHER,
      reactions: [
        { user_id: TARGET, emoji_name: "+1", create_at: 1 },
        { user_id: OTHER, emoji_name: "heart", create_at: 2 },
      ],
    }),
  ];
  await writeNdjson(join(workDir, "posts", `${CHANNEL}.ndjson`), posts);

  await writeNdjson(join(workDir, "users.ndjson"), [
    {
      id: TARGET,
      username: "personne-visee",
      nickname: "Visee",
      first_name: "Pre",
      last_name: "Nom",
      position: "Poste",
      roles: "system_user",
      is_bot: false,
      create_at: 1,
      delete_at: 0,
      avatar: `avatars/${TARGET}.png`,
    },
    {
      id: OTHER,
      username: "autre",
      nickname: "",
      first_name: "",
      last_name: "",
      position: "",
      roles: "system_user",
      is_bot: false,
      create_at: 1,
      delete_at: 0,
      avatar: null,
    },
  ]);

  await writeNdjson(join(workDir, "files.ndjson"), [
    {
      id: FILE_OF_TARGET,
      post_id: "q".repeat(26),
      channel_id: CHANNEL,
      user_id: TARGET,
      name: "document.pdf",
      extension: "pdf",
      size: 4,
      mime_type: "application/pdf",
      width: 0,
      height: 0,
      has_preview_image: false,
      create_at: 1,
      delete_at: 0,
      path: `attachments/${FILE_OF_TARGET}/document.pdf`,
    },
  ]);

  await writeNdjson(join(workDir, "channels.ndjson"), [
    {
      id: CHANNEL,
      team_id: TEAM,
      name: "canal",
      display_name: "Canal",
      type: "O",
      header: "",
      purpose: "",
      create_at: 1,
      delete_at: 0,
      total_msg_count: 3,
      last_post_at: 1_700_000_000_000,
      was_joined_by_tool: false,
      archived_post_count: 3,
    },
  ]);

  await writeNdjson(join(workDir, "teams.ndjson"), [
    {
      id: TEAM,
      name: "team",
      display_name: "Team",
      description: "",
      type: "O",
      create_at: 1,
      delete_at: 0,
      was_joined_by_tool: false,
    },
  ]);
  await writeFile(join(workDir, "emojis.ndjson"), "", "utf8");
  await writeFile(join(workDir, "avatars", `${TARGET}.png`), "image", "utf8");
  await writeFile(join(workDir, "attachments", FILE_OF_TARGET, "document.pdf"), "%PDF", "utf8");

  await writeFile(
    join(workDir, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      tool_version: "0.1.0",
      source: { url: "https://mm.example.org", server_version: "10.12.4" },
      extracted_at: "2026-08-25T00:00:00.000Z",
      extracted_by: { user_id: OTHER, username: "autre", was_system_admin: false },
      selection: {
        mode: "file",
        channels_total_public: 1,
        channels_selected: 1,
        channels_already_member: 1,
        channels_joined_by_tool: 0,
        channels_archived: 0,
      },
      options: {
        include_emails: false,
        skip_files: false,
        leave_after: false,
        max_file_size_mb: 100,
        concurrency: 4,
        rate_limit: 8,
      },
      joined_channels: [],
      joined_teams: [],
      counts: {
        teams: 1,
        channels: 1,
        posts: 3,
        users: 2,
        emojis: 0,
        attachments: 1,
        attachments_bytes: 4,
      },
      post_range: { first_create_at: 1_700_000_000_000, last_create_at: 1_700_000_000_000 },
      warnings: [],
    }),
    "utf8",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(workDir, file), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-redact-"));
  await buildArchive();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("pseudonymFor", () => {
  it("donne toujours le meme pseudonyme pour un identifiant", () => {
    expect(pseudonymFor(TARGET)).toBe(pseudonymFor(TARGET));
  });

  it("ne laisse pas transparaitre l identifiant d origine", () => {
    expect(pseudonymFor(TARGET)).not.toContain(TARGET);
  });

  it("distingue deux personnes", () => {
    expect(pseudonymFor(TARGET)).not.toBe(pseudonymFor(OTHER));
  });
});

describe("redact en mode remove", () => {
  it("supprime les messages de la personne et sa fiche", async () => {
    const result = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });

    expect(result.postsRemoved).toBe(2);
    expect(result.userRemoved).toBe(true);

    const posts = await readLines(`posts/${CHANNEL}.ndjson`);
    expect(posts).toHaveLength(1);
    expect(posts.every((p) => p.user_id !== TARGET)).toBe(true);

    const users = await readLines("users.ndjson");
    expect(users.map((u) => u.id)).toEqual([OTHER]);
  });

  it("retire les reactions de la personne des messages conserves", async () => {
    const result = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    expect(result.reactionsRemoved).toBe(1);

    const posts = await readLines(`posts/${CHANNEL}.ndjson`);
    const reactions = posts.flatMap((p) => p.reactions as { user_id: string }[]);
    expect(reactions.every((r) => r.user_id !== TARGET)).toBe(true);
    expect(reactions).toHaveLength(1);
  });

  it("efface l avatar du disque", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    expect(await exists(join(workDir, "avatars", `${TARGET}.png`))).toBe(false);
  });

  it("efface aussi le contenu des pieces jointes, pas seulement leur fiche", async () => {
    // Une demande d effacement porte sur les donnees, pas sur l index qui les
    // decrit : laisser le binaire sur disque ne vaut pas effacement.
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    expect(await exists(join(workDir, "attachments", FILE_OF_TARGET, "document.pdf"))).toBe(false);
  });

  it("laisse une archive qui passe encore sa propre verification", async () => {
    // Une commande de conformite ne doit pas casser l archive : sinon on choisit
    // entre respecter une demande d effacement et garder une archive lisible.
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });

    const report = await verifyArchive({ archiveDir: workDir, checkBlobs: true });
    const failures = report.results.filter((r) => r.severity === "error");
    expect(failures.map((f) => `${f.label} ${f.detail ?? ""}`)).toEqual([]);
  });

  it("ne touche pas aux donnees des autres personnes", async () => {
    const before = await readLines("users.ndjson");
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    const after = await readLines("users.ndjson");
    expect(after).toEqual(before.filter((u) => u.id === OTHER));
  });
});

describe("redact en mode pseudonymize", () => {
  it("conserve les messages en remplacant l auteur", async () => {
    const result = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });

    expect(result.postsRemoved).toBe(0);
    expect(result.postsRewritten).toBe(2);

    const posts = await readLines(`posts/${CHANNEL}.ndjson`);
    expect(posts).toHaveLength(3);
    expect(posts.filter((p) => p.user_id === pseudonymFor(TARGET))).toHaveLength(2);
    expect(posts.every((p) => p.user_id !== TARGET)).toBe(true);
  });

  it("efface les elements identifiants de la fiche", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    const users = await readLines("users.ndjson");
    const anon = users.find((u) => u.id === pseudonymFor(TARGET));
    expect(anon).toBeDefined();
    expect(anon?.username).toBe(pseudonymFor(TARGET));
    expect(anon?.first_name).toBe("");
    expect(anon?.last_name).toBe("");
    expect(anon?.nickname).toBe("");
    expect(anon?.position).toBe("");
    expect(anon?.avatar).toBeNull();
  });

  it("efface l avatar du disque, la fiche ne le referencant plus", async () => {
    // Garder l image alors que l enregistrement ne la cite plus laisserait un
    // portrait identifiable orphelin dans l archive.
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    expect(await exists(join(workDir, "avatars", `${TARGET}.png`))).toBe(false);
  });

  it("conserve les pieces jointes en reattribuant leur proprietaire", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    const files = await readLines("files.ndjson");
    expect(files).toHaveLength(1);
    expect(files[0]?.user_id).toBe(pseudonymFor(TARGET));
    expect(await exists(join(workDir, "attachments", FILE_OF_TARGET, "document.pdf"))).toBe(true);
  });

  it("laisse une archive qui passe encore sa propre verification", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    const report = await verifyArchive({ archiveDir: workDir, checkBlobs: true });
    const failures = report.results.filter((r) => r.severity === "error");
    expect(failures.map((f) => `${f.label} ${f.detail ?? ""}`)).toEqual([]);
  });

  it("est idempotent : rejouer ne change plus rien", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    const afterFirst = await readLines(`posts/${CHANNEL}.ndjson`);

    const second = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      logger: silent,
    });
    expect(second.postsRewritten).toBe(0);
    expect(await readLines(`posts/${CHANNEL}.ndjson`)).toEqual(afterFirst);
  });
});

describe("garde-fous", () => {
  it("ne fait rien pour un identifiant absent de l archive", async () => {
    const before = await readLines(`posts/${CHANNEL}.ndjson`);
    const result = await redactArchive({
      archiveDir: workDir,
      userId: "z".repeat(26),
      mode: "remove",
      logger: silent,
    });
    expect(result.postsRemoved).toBe(0);
    expect(result.userRemoved).toBe(false);
    expect(await readLines(`posts/${CHANNEL}.ndjson`)).toEqual(before);
  });

  it("ne laisse aucun fichier temporaire derriere lui", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    expect(await exists(join(workDir, "users.ndjson.redact"))).toBe(false);
    expect(await exists(join(workDir, "files.ndjson.redact"))).toBe(false);
  });

  it("annonce ce qui serait efface sans rien modifier", async () => {
    // L operation est irreversible : la simulation doit compter exactement ce
    // que ferait la vraie passe, et laisser l archive rigoureusement intacte.
    const avant = await empreinteArchive();

    const simule = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      dryRun: true,
      logger: silent,
    });
    expect(simule.dryRun).toBe(true);
    expect(await empreinteArchive()).toEqual(avant);

    const reel = await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "remove",
      logger: silent,
    });
    expect(await empreinteArchive()).not.toEqual(avant);

    // Les decomptes de la simulation sont ceux de l operation.
    expect(simule.postsRemoved).toBe(reel.postsRemoved);
    expect(simule.reactionsRemoved).toBe(reel.reactionsRemoved);
    expect(simule.attachmentsDeleted).toBe(reel.attachmentsDeleted);
    expect(simule.userRemoved).toBe(reel.userRemoved);
  });

  it("ne laisse aucun fichier de travail derriere une simulation", async () => {
    await redactArchive({
      archiveDir: workDir,
      userId: TARGET,
      mode: "pseudonymize",
      dryRun: true,
      logger: silent,
    });
    const restes: string[] = [];
    for (const [chemin] of await empreinteArchive()) {
      if (chemin.endsWith(".redact")) restes.push(chemin);
    }
    expect(restes).toEqual([]);
  });
});

describe("redact face a un identifiant invalide", () => {
  const INVALIDE = "pas-un-identifiant";

  it("refuse avant d avoir touche a l archive", async () => {
    const avant = await empreinteArchive();
    await expect(
      redactArchive({ archiveDir: workDir, userId: INVALIDE, mode: "remove", logger: silent }),
    ).rejects.toThrow();
    // Une demande d effacement est irreversible : echouer a mi-parcours laisse
    // les messages deja reecrits et le manifeste en desaccord avec eux.
    expect(await empreinteArchive()).toEqual(avant);
  });

  it("le signale des la simulation, qui sert justement a relire l operation", async () => {
    await expect(
      redactArchive({
        archiveDir: workDir,
        userId: INVALIDE,
        mode: "remove",
        dryRun: true,
        logger: silent,
      }),
    ).rejects.toThrow();
  });
});

describe("redact face a un avatar illisible", () => {
  it("s arrete au lieu de le prendre pour un avatar absent", async () => {
    const avatarsDir = join(workDir, "avatars");
    const avant = await empreinteArchive();
    await chmod(avatarsDir, 0o000);
    try {
      // Un acces refuse n est pas une absence : le confondre ferait echouer la
      // suppression plus tard, une fois les messages deja reecrits.
      await expect(
        redactArchive({ archiveDir: workDir, userId: TARGET, mode: "remove", logger: silent }),
      ).rejects.toThrow();
    } finally {
      await chmod(avatarsDir, 0o755);
    }
    expect(await empreinteArchive()).toEqual(avant);
  });
});
