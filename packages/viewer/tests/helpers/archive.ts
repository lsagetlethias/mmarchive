import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CHANNEL_A = "a".repeat(26);
export const CHANNEL_B = "b".repeat(26);
export const ALICE = "1".repeat(26);
export const BOB = "2".repeat(26);
export const FILE_KEPT = "f".repeat(26);
export const FILE_SKIPPED = "g".repeat(26);

/** Contenu binaire arbitraire, assez long pour tester une requete par plage. */
export const PDF_BYTES = Buffer.from(`%PDF-1.4\n${"x".repeat(4096)}`);

export function id(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(25, "0")}`;
}

export function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: id("p", 1),
    channel_id: CHANNEL_A,
    user_id: ALICE,
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

export function channel(cid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: cid,
    team_id: "t".repeat(26),
    name: cid === CHANNEL_A ? "general" : "tech-archi",
    display_name: cid === CHANNEL_A ? "General" : "Tech archi",
    type: "O",
    header: "",
    purpose: "",
    create_at: 1,
    delete_at: 0,
    total_msg_count: 0,
    last_post_at: 0,
    was_joined_by_tool: false,
    archived_post_count: 0,
    ...over,
  };
}

export function user(
  uid: string,
  username: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: uid,
    username,
    nickname: "",
    first_name: "",
    last_name: "",
    position: "",
    roles: "system_user",
    is_bot: false,
    create_at: 1,
    delete_at: 0,
    avatar: null,
    ...over,
  };
}

export async function writeNdjson(
  path: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

export function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    tool_version: "0.1.0",
    source: { url: "https://exemple.test", server_version: "10.0.0" },
    extracted_at: "2026-08-25T10:00:00.000Z",
    extracted_by: { user_id: ALICE, username: "alice", was_system_admin: false },
    selection: {
      mode: "file",
      channels_total_public: 2,
      channels_selected: 2,
      channels_already_member: 2,
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
      channels: 2,
      posts: 0,
      users: 2,
      emojis: 0,
      attachments: 0,
      attachments_bytes: 0,
    },
    warnings: [],
    ...over,
  };
}

/**
 * Deux canaux dont les messages s entrelacent dans le temps : c est la seule
 * disposition qui distingue un rowid chronologique global d un rowid groupe par
 * canal, et donc la seule qui teste vraiment l invariant.
 */
export async function writeArchive(archiveDir: string): Promise<void> {
  await mkdir(join(archiveDir, "posts"), { recursive: true });
  await writeFile(join(archiveDir, "manifest.json"), JSON.stringify(manifest()), "utf8");

  await writeNdjson(join(archiveDir, "channels.ndjson"), [channel(CHANNEL_A), channel(CHANNEL_B)]);
  await writeNdjson(join(archiveDir, "users.ndjson"), [
    user(ALICE, "alice", {
      first_name: "Alice",
      last_name: "Martin",
      avatar: `avatars/${ALICE}.png`,
    }),
    user(BOB, "bob"),
  ]);
  await writeNdjson(join(archiveDir, "emojis.ndjson"), [
    {
      id: "e".repeat(26),
      name: "perroquet",
      creator_id: ALICE,
      create_at: 1,
      update_at: 1,
      delete_at: 0,
      image: "emoji/x.png",
    },
  ]);

  // Canal A aux instants 100, 300, 500. Canal B aux instants 200 et 400.
  await writeNdjson(join(archiveDir, "posts", `${CHANNEL_A}.ndjson`), [
    post({ id: id("a", 1), create_at: 100, message: "premier message de reunion" }),
    post({
      id: id("a", 2),
      create_at: 300,
      root_id: id("a", 1),
      message: "une reponse dans le fil",
      reactions: [
        { user_id: BOB, emoji_name: "+1", create_at: 301 },
        { user_id: ALICE, emoji_name: "perroquet", create_at: 302 },
      ],
    }),
    post({
      id: id("a", 3),
      create_at: 500,
      user_id: BOB,
      edit_at: 501,
      message: "note de cadrage a relire",
      hashtags: "#suivi-projet",
      file_ids: [FILE_KEPT, FILE_SKIPPED],
    }),
    // Message de bot : contenu dans props, doit rester hors de l index.
    post({
      id: id("a", 4),
      create_at: 550,
      type: "slack_attachment",
      message: "",
      props: { attachments: [{ text: "notification de pull request" }] },
    }),
    post({
      id: id("a", 5),
      create_at: 560,
      type: "system_join_channel",
      message: "alice a rejoint",
    }),
  ]);

  await writeNdjson(join(archiveDir, "posts", `${CHANNEL_B}.ndjson`), [
    post({
      id: id("b", 1),
      channel_id: CHANNEL_B,
      create_at: 200,
      user_id: BOB,
      message: "reunion hebdomadaire reportee",
    }),
    // Reponse a une racine absente de l archive : le format le prevoit.
    post({
      id: id("b", 2),
      channel_id: CHANNEL_B,
      create_at: 400,
      root_id: id("z", 9),
      message: "reponse orpheline",
    }),
  ]);

  await mkdir(join(archiveDir, "attachments", FILE_KEPT), { recursive: true });
  await mkdir(join(archiveDir, "avatars"), { recursive: true });
  await mkdir(join(archiveDir, "emoji"), { recursive: true });
  await writeFile(join(archiveDir, "attachments", FILE_KEPT, "cadrage.pdf"), PDF_BYTES);
  await writeFile(join(archiveDir, "avatars", `${ALICE}.png`), "avatar factice", "utf8");
  await writeFile(join(archiveDir, "emoji", "x.png"), "emoji factice", "utf8");

  await writeNdjson(join(archiveDir, "files.ndjson"), [
    {
      id: FILE_KEPT,
      post_id: id("a", 3),
      channel_id: CHANNEL_A,
      user_id: BOB,
      name: "cadrage.pdf",
      extension: "pdf",
      size: 1024,
      mime_type: "application/pdf",
      width: 0,
      height: 0,
      has_preview_image: false,
      create_at: 500,
      delete_at: 0,
      path: `attachments/${FILE_KEPT}/cadrage.pdf`,
    },
    {
      id: FILE_SKIPPED,
      post_id: id("a", 3),
      channel_id: CHANNEL_A,
      user_id: BOB,
      name: "video.mov",
      extension: "mov",
      size: 900_000_000,
      mime_type: "video/quicktime",
      width: 0,
      height: 0,
      has_preview_image: false,
      create_at: 500,
      delete_at: 0,
      path: null,
      skip_reason: "too_large",
    },
  ]);
}

/**
 * Archive volumineuse et repartie dans le temps, pour la pagination et les
 * bornes de dates. Un message par jour, alternant les deux canaux.
 */
export async function writeDatedArchive(archiveDir: string, days: number): Promise<void> {
  await mkdir(join(archiveDir, "posts"), { recursive: true });
  await writeFile(join(archiveDir, "manifest.json"), JSON.stringify(manifest()), "utf8");
  await writeNdjson(join(archiveDir, "channels.ndjson"), [channel(CHANNEL_A), channel(CHANNEL_B)]);
  await writeNdjson(join(archiveDir, "users.ndjson"), [user(ALICE, "alice"), user(BOB, "bob")]);

  const inA: Record<string, unknown>[] = [];
  const inB: Record<string, unknown>[] = [];
  for (let day = 0; day < days; day += 1) {
    const createAt = Date.UTC(2026, 0, 1 + day, 12, 0, 0);
    const target = day % 2 === 0 ? inA : inB;
    target.push(
      post({
        id: id(day % 2 === 0 ? "a" : "b", day + 1),
        channel_id: day % 2 === 0 ? CHANNEL_A : CHANNEL_B,
        user_id: day % 2 === 0 ? ALICE : BOB,
        create_at: createAt,
        message: `message du jour ${String(day + 1)}`,
      }),
    );
  }
  await writeNdjson(join(archiveDir, "posts", `${CHANNEL_A}.ndjson`), inA);
  await writeNdjson(join(archiveDir, "posts", `${CHANNEL_B}.ndjson`), inB);
  await writeNdjson(join(archiveDir, "files.ndjson"), []);
}
