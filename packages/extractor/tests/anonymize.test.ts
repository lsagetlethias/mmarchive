import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMattermostId, type Manifest, manifestSchema } from "@mmarchive/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnonymizeError, anonymizeArchive } from "../src/redact/anonymize-archive.js";
import { buildIdentityTable } from "../src/redact/identity-table.js";
import { Logger } from "../src/ui/logger.js";
import { verifyArchive } from "../src/verify/checks.js";

const ALICE = "a".repeat(26);
const BOB = "b".repeat(26);
const ORPHELIN = "z".repeat(26);
const CHANNEL = "c".repeat(26);
const TEAM = "m".repeat(26);
const FICHIER = "f".repeat(26);
const EMOJI = "e".repeat(26);

const silent = new Logger({ level: "error" });

let source: string;
let sortie: string;

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p".repeat(26),
    channel_id: CHANNEL,
    user_id: BOB,
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

async function writeNdjson(path: string, records: unknown[]): Promise<void> {
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

async function lire(fichier: string, racine = sortie): Promise<Record<string, unknown>[]> {
  const brut = await readFile(join(racine, fichier), "utf8");
  return brut
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Retrouve une fiche anonymisee par un champ que la passe ne touche pas.
 *
 * Les fiches sortent dans l ordre de leur identifiant de substitution, tire au
 * hasard : les designer par leur rang reviendrait a supposer l ordre de la
 * source, c est a dire la fuite que ce tri ferme.
 */
async function fiche(roles: string): Promise<Record<string, unknown>> {
  const trouvee = (await lire("users.ndjson")).find((u) => u.roles === roles);
  if (trouvee === undefined) throw new Error(`aucune fiche avec roles=${roles}`);
  return trouvee;
}

const ALICE_ROLES = "system_user system_admin";
const BOB_ROLES = "system_user";

async function manifeste(racine = sortie): Promise<Manifest> {
  const brut: unknown = JSON.parse(await readFile(join(racine, "manifest.json"), "utf8"));
  return manifestSchema.parse(brut);
}

/** Archive minimale mais complete : verify doit pouvoir se prononcer dessus. */
async function buildArchive(): Promise<void> {
  await mkdir(join(source, "posts"), { recursive: true });
  await mkdir(join(source, "avatars"), { recursive: true });
  await mkdir(join(source, "emoji"), { recursive: true });
  await mkdir(join(source, "attachments", FICHIER), { recursive: true });

  await writeNdjson(join(source, "posts", `${CHANNEL}.ndjson`), [
    post({
      id: "p".repeat(26),
      user_id: ALICE,
      message: "bonjour",
      hashtags: "#alice.martin",
      reactions: [
        { user_id: BOB, emoji_name: "+1", create_at: 1 },
        { user_id: ORPHELIN, emoji_name: "heart", create_at: 2 },
      ],
    }),
    post({
      id: "q".repeat(26),
      type: "system_add_to_channel",
      user_id: BOB,
      message: "",
      props: { userId: BOB, addedUserId: ALICE, addedUsername: "alice.martin" },
    }),
    post({
      id: "r".repeat(26),
      type: "system_add_to_channel",
      message: "",
      props: { addedUserId: ORPHELIN, addedUsername: "compte-disparu" },
    }),
    post({
      id: "w".repeat(26),
      type: "system_add_to_channel",
      user_id: BOB,
      // Un nom court designe par props ne doit pas etre remplace a l interieur
      // d un mot plus long : « bob » ne transforme pas « bobsleigh ».
      message: "bobsleigh et bob.martin ont ete evoques par bob, avec bob_.",
      props: { username: "bob" },
    }),
    post({
      id: "v".repeat(26),
      type: "system_add_to_channel",
      user_id: BOB,
      // Le gabarit reel de Mattermost : le texte nomme les deux personnes que
      // props designe par ailleurs.
      message: "alice.martin a ete ajoute au canal par bob.",
      props: { addedUsername: "alice.martin", username: "bob" },
    }),
    post({
      id: "s".repeat(26),
      type: "slack_attachment",
      message: "",
      props: {
        from_webhook: "true",
        override_username: "GitHub",
        attendents: "Alice Martin",
        attachments: [
          {
            fallback: "corps du bloc",
            text: "le contenu utile",
            title: "un titre",
            color: "#ff0000",
            author_name: "Alice Martin",
            author_link: "https://interne.example.org/u/alice",
            title_link: "https://interne.example.org/t/1",
            fields: [{ title: "Culprit", value: "api.v1", short: true }],
          },
        ],
      },
    }),
    post({
      id: "t".repeat(26),
      type: "custom_jitsi",
      message: "",
      props: { ended_by: "alice.martin", participants: [BOB, ORPHELIN] },
    }),
    // U+2028 est legal dans une chaine JSON et n est pas echappe par
    // JSON.stringify. Un decoupage par readline couperait la ligne en deux.
    post({ id: "u".repeat(26), message: "avant\u2028apres\u2029suite" }),
  ]);

  await writeNdjson(join(source, "users.ndjson"), [
    {
      id: ALICE,
      username: "alice.martin",
      nickname: "alice.martin@example.org",
      first_name: "Alice",
      last_name: "Martin",
      position: "Directrice technique",
      roles: "system_user system_admin",
      is_bot: false,
      create_at: 1,
      delete_at: 0,
      avatar: `avatars/${ALICE}.png`,
      email: "alice.martin@example.org",
    },
    {
      id: BOB,
      username: "bob",
      nickname: "",
      first_name: "Bob",
      last_name: "Durand",
      position: "",
      roles: "system_user",
      is_bot: false,
      create_at: 1,
      delete_at: 0,
      avatar: null,
    },
  ]);

  await writeNdjson(join(source, "files.ndjson"), [
    {
      id: FICHIER,
      post_id: "p".repeat(26),
      channel_id: CHANNEL,
      user_id: ALICE,
      name: "CV Alice Martin.pdf",
      extension: "pdf",
      size: 4,
      mime_type: "application/pdf",
      width: 0,
      height: 0,
      has_preview_image: false,
      create_at: 1,
      delete_at: 0,
      path: `attachments/${FICHIER}/CV Alice Martin.pdf`,
    },
  ]);

  await writeNdjson(join(source, "emojis.ndjson"), [
    {
      id: EMOJI,
      name: "alice",
      creator_id: ALICE,
      create_at: 1,
      update_at: 1,
      delete_at: 0,
      image: `emoji/${EMOJI}.png`,
    },
    {
      id: "d".repeat(26),
      name: "orphelin",
      creator_id: ORPHELIN,
      create_at: 1,
      update_at: 1,
      delete_at: 0,
      image: `emoji/${"d".repeat(26)}.png`,
    },
  ]);

  await writeNdjson(join(source, "channels.ndjson"), [
    {
      id: CHANNEL,
      team_id: TEAM,
      name: "canal",
      display_name: "Canal",
      type: "O",
      header: "Contact : Alice Martin, 06 12 34 56 78",
      purpose: "Objet du canal",
      create_at: 1,
      delete_at: 0,
      total_msg_count: 8,
      last_post_at: 1_700_000_000_000,
      was_joined_by_tool: false,
      archived_post_count: 8,
    },
  ]);

  await writeNdjson(join(source, "teams.ndjson"), [
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

  await writeFile(join(source, "avatars", `${ALICE}.png`), "image", "utf8");
  await writeFile(join(source, "emoji", `${EMOJI}.png`), "image", "utf8");
  await writeFile(join(source, "attachments", FICHIER, "CV Alice Martin.pdf"), "%PDF", "utf8");
  await writeFile(
    join(source, ".extract-state.json"),
    JSON.stringify({ fetched_user_ids: [ALICE, BOB] }),
    "utf8",
  );

  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      tool_version: "0.1.0",
      source: { url: "https://mm.example.org", server_version: "10.12.4" },
      extracted_at: "2026-08-25T00:00:00.000Z",
      extracted_by: { user_id: ALICE, username: "alice.martin", was_system_admin: true },
      selection: {
        mode: "file",
        channels_total_public: 1,
        channels_selected: 1,
        channels_already_member: 1,
        channels_joined_by_tool: 0,
        channels_archived: 0,
      },
      options: {
        include_emails: true,
        skip_files: false,
        leave_after: false,
        max_file_size_mb: 100,
        concurrency: 4,
        rate_limit: 10,
      },
      joined_channels: [],
      joined_teams: [],
      counts: {
        teams: 1,
        channels: 1,
        posts: 8,
        users: 2,
        emojis: 2,
        attachments: 1,
        attachments_bytes: 4,
      },
      post_range: { first_create_at: 1_700_000_000_000, last_create_at: 1_700_000_000_000 },
      warnings: [
        { code: "USER_FETCH_FAILED", detail: `Avatar de alice.martin indisponible (${ALICE})` },
      ],
    }),
    "utf8",
  );
}

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "mmarchive-anon-src-"));
  sortie = join(await mkdtemp(join(tmpdir(), "mmarchive-anon-out-")), "sortie");
  await buildArchive();
});

afterEach(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(join(sortie, ".."), { recursive: true, force: true });
});

async function anonymiser(): Promise<void> {
  await anonymizeArchive({ archiveDir: source, outDir: sortie, logger: silent });
}

describe("l archive source", () => {
  it("n est jamais modifiee", async () => {
    const empreinte = async (): Promise<[string, string][]> => {
      const entrees = await readdir(source, { recursive: true, withFileTypes: true });
      const out: [string, string][] = [];
      for (const entree of entrees) {
        if (!entree.isFile()) continue;
        const chemin = join(entree.parentPath, entree.name);
        out.push([chemin.slice(source.length), await readFile(chemin, "utf8")]);
      }
      return out.sort(([a], [b]) => (a < b ? -1 : 1));
    };
    const avant = await empreinte();
    await anonymiser();
    expect(await empreinte()).toEqual(avant);
  });
});

describe("les comptes", () => {
  it("recoivent trois formes, une par lecteur", async () => {
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    // L identifiant garde la forme du format, sans quoi toute relecture echoue.
    expect(isMattermostId(alice.id as string)).toBe(true);
    // La colonne username de l index n a pas de COLLATE : une forme capitalisee
    // ferait echouer la recherche from: en silence.
    expect(alice.username).toMatch(/^anon-[a-z]+-[a-z]+(-\d+)?$/);
    expect(alice.first_name).toMatch(/^Anon-[A-Z][a-z]+-[A-Z][a-z]+(-\d+)?$/);
  });

  it("perdent tout ce qui les designait", async () => {
    await anonymiser();
    const users = await lire("users.ndjson");
    for (const user of users) {
      expect(user.last_name).toBe("");
      expect(user.nickname).toBe("");
      expect(user.position).toBe("");
      expect(user.avatar).toBeNull();
      // Retire, pas vide : le schema declare le champ optionnel.
      expect("email" in user).toBe(false);
    }
  });

  it("gardent ce qui ne designe personne", async () => {
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    expect(alice.roles).toBe("system_user system_admin");
    expect(alice.is_bot).toBe(false);
  });
});

describe("les references d identite", () => {
  it("suivent la meme table dans tous les fichiers", async () => {
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const [fichier] = await lire("files.ndjson");
    const [emoji] = await lire("emojis.ndjson");
    // Un identifiant reecrit d un cote et pas de l autre ne leve rien : il
    // produit un auteur non resolu que le viewer fusionne avec les autres.
    expect(posts[0]?.user_id).toBe(alice.id);
    expect(fichier?.user_id).toBe(alice.id);
    expect(emoji?.creator_id).toBe(alice.id);
  });

  it("valent aussi pour les reactions, que verify ne regarde jamais", async () => {
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const reactions = posts[0]?.reactions as { user_id: string }[];
    for (const reaction of reactions) expect(reaction.user_id).not.toBe(BOB);
    // Celle de l orphelin disparait plutot que de survivre en clair.
    expect(reactions).toHaveLength(1);
  });

  it("disparaissent quand elles ne resolvent vers aucun compte", async () => {
    // Le cas est reel : des comptes supprimes de l instance restent references
    // par des messages systeme. Un repli du type table.get(x) ?? x les
    // laisserait intacts, et le controle residuel ne pourrait pas les voir.
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const orphelin = posts.find((p) => p.id === "r".repeat(26));
    const props = orphelin?.props as Record<string, unknown>;
    expect("addedUserId" in props).toBe(false);
    expect("addedUsername" in props).toBe(false);
    const brut = await readFile(join(sortie, "posts", `${CHANNEL}.ndjson`), "utf8");
    expect(brut).not.toContain(ORPHELIN);
  });
});

describe("props", () => {
  it("reecrit les references, par identifiant comme par nom", async () => {
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    const bob = await fiche(BOB_ROLES);
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const props = posts.find((p) => p.id === "q".repeat(26))?.props as Record<string, unknown>;
    expect(props.userId).toBe(bob.id);
    expect(props.addedUserId).toBe(alice.id);
    // Sur un system_add_to_channel, le nom de la personne ajoutee vit ici et
    // nulle part ailleurs : une reecriture du seul champ message le raterait.
    expect(props.addedUsername).toBe(alice.username);
  });

  it("resout une cle polymorphe sur sa valeur, pas sur son nom", async () => {
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    const bob = await fiche(BOB_ROLES);
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const props = posts.find((p) => p.id === "t".repeat(26))?.props as Record<string, unknown>;
    // ended_by porte tantot un identifiant, tantot un nom.
    expect(props.ended_by).toBe(alice.username);
    expect(props.participants).toEqual([bob.id]);
  });

  it("laisse tomber toute cle qu elle ne sait pas justifier", async () => {
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const props = posts.find((p) => p.id === "s".repeat(26))?.props as Record<string, unknown>;
    // attendents est mal orthographiee par un plugin et porte des noms : aucune
    // liste noire ecrite a l avance ne l aurait attrapee.
    expect("attendents" in props).toBe(false);
    expect("override_username" in props).toBe(false);
    expect(props.from_webhook).toBe("true");
  });

  it("garde le corps des blocs attachments et retire ce qui designe", async () => {
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const props = posts.find((p) => p.id === "s".repeat(26))?.props as Record<string, unknown>;
    const bloc = (props.attachments as Record<string, unknown>[])[0];
    // Vider ces blocs effacerait le corps entier de 16,5 % des messages, dont
    // le champ message est vide.
    expect(bloc?.text).toBe("le contenu utile");
    expect(bloc?.fallback).toBe("corps du bloc");
    expect(bloc?.fields).toEqual([{ title: "Culprit", value: "api.v1", short: true }]);
    expect("author_name" in (bloc ?? {})).toBe(false);
    expect("author_link" in (bloc ?? {})).toBe(false);
    expect("title_link" in (bloc ?? {})).toBe(false);
  });
});

describe("la table de correspondance", () => {
  it("ne se lit pas dans le texte d un message systeme", async () => {
    // Le defaut le plus grave trouve sur cette commande : « alice a ete ajoute
    // par bob » reste intact a cote d un props reecrit en anon-..., donc une
    // seule ligne apparie l identite reelle et son substitut. Mesure sur
    // l archive de reference : 65 577 messages appariant 3 237 comptes sur
    // 3 277. Le sel jete ne protege de rien quand la reponse est ecrite a cote
    // de la question.
    await anonymiser();
    const alice = await fiche(ALICE_ROLES);
    const bob = await fiche(BOB_ROLES);
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const systeme = posts.find((p) => p.id === "v".repeat(26));
    expect(systeme?.message).not.toContain("alice.martin");
    expect(systeme?.message).not.toContain("bob");
    // Le fil reste lisible : le texte nomme les memes personnes que props.
    const props = systeme?.props as Record<string, unknown>;
    expect(systeme?.message).toContain(props.addedUsername as string);
    expect(systeme?.message).toContain(props.username as string);
    expect([alice.username, bob.username]).toContain(props.addedUsername);
  });

  it("ne substitue un nom qu en jeton entier, jamais dans un mot", async () => {
    // Un remplacement brut de la valeur de props atteindrait l interieur des
    // mots : un compte nomme « bob » transformerait « bobsleigh ».
    await anonymiser();
    const bob = await fiche(BOB_ROLES);
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    const message = posts.find((p) => p.id === "w".repeat(26))?.message as string;
    expect(message).toContain("bobsleigh");
    expect(message).toContain("bob.martin");
    // Un tiret bas final appartient au nom, il n est pas de la ponctuation :
    // « bob_ » est un autre compte que « bob », et ne doit pas etre substitue.
    expect(message).toContain("bob_");
    expect(message).toContain(bob.username as string);
    expect(message.startsWith("bobsleigh")).toBe(true);
  });

  it("ne se lit pas dans l ordre des fiches de comptes", async () => {
    // Ecrire les comptes dans l ordre de la source rendait la table complete a
    // qui detient l archive d origine, par un simple paste ligne a ligne.
    await anonymiser();
    const source_ = (await lire("users.ndjson", source)).map((u) => u.id as string);
    const sortie_ = (await lire("users.ndjson")).map((u) => u.id as string);
    expect(sortie_).toHaveLength(source_.length);
    // Les fiches sortent dans l ordre de leur identifiant de substitution, qui
    // est tire au hasard : il ne dit rien de l ordre d entree.
    expect([...sortie_].sort()).toEqual(sortie_);
  });
});

describe("les binaires et ce qui les nomme", () => {
  it("ne sont pas repris", async () => {
    await anonymiser();
    const entrees = await readdir(sortie);
    expect(entrees).not.toContain("avatars");
    expect(entrees).not.toContain("attachments");
    expect(entrees).not.toContain("emoji");
  });

  it("laissent une metadonnee neutre plutot qu un nom de televersement", async () => {
    await anonymiser();
    const [fichier] = await lire("files.ndjson");
    expect(fichier?.name).toBe("piece-jointe-1.pdf");
    // Le viewer affiche ce nom meme quand le binaire manque.
    expect(fichier?.path).toBeNull();
    expect(fichier?.size).toBe(4);
  });

  it("emportent le fichier d etat, qui porte la liste des comptes", async () => {
    await anonymiser();
    expect(await readdir(sortie)).not.toContain(".extract-state.json");
  });

  it("annulent l image des emojis sans supprimer leur ligne", async () => {
    await anonymiser();
    const emojis = await lire("emojis.ndjson");
    // En retirer ferait diverger counts.emojis, que la verification compare.
    expect(emojis).toHaveLength(2);
    for (const emoji of emojis) expect(emoji.image).toBeNull();
  });
});

describe("le manifeste", () => {
  it("perd l URL de l instance et l identite de l operateur", async () => {
    await anonymiser();
    const manifest = await manifeste();
    expect(manifest.source.url).toBe("");
    expect(manifest.source.server_version).toBe("10.12.4");
    expect(manifest.extracted_by.user_id).not.toBe(ALICE);
    expect(manifest.extracted_by.username).not.toBe("alice.martin");
    expect(manifest.extracted_by.was_system_admin).toBe(true);
  });

  it("vide le detail des avertissements sans perdre leur code", async () => {
    await anonymiser();
    const manifest = await manifeste();
    // On ne reecrit pas sainement de la prose d erreur interpolee avec des noms.
    expect(manifest.warnings[0]?.code).toBe("USER_FETCH_FAILED");
    expect(manifest.warnings[0]?.detail).toBe("");
  });

  it("declare le passage, et zod ne le strippe pas", async () => {
    await anonymiser();
    const manifest = await manifeste();
    expect(manifest.anonymized?.binaries_removed).toBe(true);
    // Faux tant que la reecriture du texte n est pas livree : un lecteur doit
    // pouvoir savoir qu il ne tient pas encore une archive diffusable.
    expect(manifest.anonymized?.message_text_rewritten).toBe(false);
  });

  it("recale les sept compteurs, pas seulement ceux que redact recalait", async () => {
    await anonymiser();
    const manifest = await manifeste();
    expect(manifest.counts).toMatchObject({
      teams: 1,
      channels: 1,
      posts: 8,
      users: 2,
      emojis: 2,
      attachments: 0,
      attachments_bytes: 0,
    });
  });
});

describe("les champs de texte", () => {
  it("vide l en-tete de canal, qui entre dans l index sans jamais s afficher", async () => {
    await anonymiser();
    const [canal] = await lire("channels.ndjson");
    expect(canal?.header).toBe("");
    // Residu assume : le nom et l objet du canal sont conserves.
    expect(canal?.name).toBe("canal");
    expect(canal?.purpose).toBe("Objet du canal");
  });

  it("vide les mots-diese, derivation du corps qui survivrait a sa reecriture", async () => {
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    expect(posts[0]?.hashtags).toBe("");
  });

  it("laisse le corps des messages intact, y compris ses separateurs Unicode", async () => {
    await anonymiser();
    const posts = await lire(`posts/${CHANNEL}.ndjson`);
    // U+2028 et U+2029 sont legaux dans une chaine JSON et ne sont pas echappes
    // par JSON.stringify, mais readline les traite comme des fins de ligne : il
    // couperait l enregistrement en deux. Le lecteur du depot decoupe sur le seul
    // octet 0x0A.
    const survivant = posts.find((p) => p.id === "u".repeat(26));
    expect(survivant?.message).toBe("avant\u2028apres\u2029suite");
    expect(posts[0]?.message).toBe("bonjour");
    expect(posts).toHaveLength(8);
  });
});

describe("les refus", () => {
  it("refuse une sortie qui designe la source", async () => {
    await expect(
      anonymizeArchive({ archiveDir: source, outDir: source, logger: silent }),
    ).rejects.toThrow(/ne modifie jamais celle qu elle lit/);
  });

  it("refuse une sortie posee a l interieur de la source", async () => {
    await expect(
      anonymizeArchive({ archiveDir: source, outDir: join(source, "dedans"), logger: silent }),
    ).rejects.toThrow(/a l interieur de l archive source/);
  });

  it("refuse une sortie deja occupee", async () => {
    await mkdir(sortie, { recursive: true });
    await writeFile(join(sortie, "quelque-chose"), "x", "utf8");
    await expect(
      anonymizeArchive({ archiveDir: source, outDir: sortie, logger: silent }),
    ).rejects.toThrow(/n est pas vide/);
  });

  it("refuse --force sur un repertoire qui n est pas une archive anonymisee", async () => {
    // --force ne doit pas devenir une suppression aveugle : pointe sur un
    // repertoire de travail, il en effacerait le contenu sans rien demander.
    await mkdir(sortie, { recursive: true });
    await writeFile(join(sortie, "notes-importantes.txt"), "x", "utf8");
    await expect(
      anonymizeArchive({ archiveDir: source, outDir: sortie, force: true, logger: silent }),
    ).rejects.toThrow(/ne porte pas d archive anonymisee complete/);
    // Le contenu est intact : la commande a refuse avant d ecrire.
    expect(await readdir(sortie)).toEqual(["notes-importantes.txt"]);
  });

  it("refuse --force sur une sortie laissee par une passe interrompue", async () => {
    // Le marqueur du manifeste n est ecrit qu en toute fin : une sortie
    // partielle ne le porte pas, et se supprime a la main apres examen.
    await anonymiser();
    await rm(join(sortie, "manifest.json"));
    await expect(
      anonymizeArchive({ archiveDir: source, outDir: sortie, force: true, logger: silent }),
    ).rejects.toThrow(/ne porte pas d archive anonymisee complete/);
  });

  it("remplace une archive anonymisee complete sans en laisser de reste", async () => {
    await anonymiser();
    // Les fichiers de messages portent le nom de leur canal d origine : sans
    // effacement, une passe depuis une autre archive laisserait ceux de la
    // premiere dans la sortie, hors des compteurs du manifeste.
    const perime = join(sortie, "posts", `${"x".repeat(26)}.ndjson`);
    await writeFile(perime, `${JSON.stringify(post())}\n`, "utf8");
    await anonymizeArchive({ archiveDir: source, outDir: sortie, force: true, logger: silent });
    await expect(readFile(perime, "utf8")).rejects.toThrow();
    expect((await readdir(join(sortie, "posts"))).sort()).toEqual([`${CHANNEL}.ndjson`]);
  });

  it("refuse un fichier de travail, signe d une extraction interrompue", async () => {
    // Le supprimer en silence produirait une archive anonyme mais tronquee,
    // sans que rien ne le dise. Les trois parcours existants du depot filtrent
    // sur .ndjson et rateraient exactement ce fichier.
    await writeFile(join(source, "posts", `${CHANNEL}.ndjson.part`), "{}\n", "utf8");
    await expect(anonymiser()).rejects.toThrow(AnonymizeError);
    await expect(anonymiser()).rejects.toThrow(/operation interrompue/);
  });

  it("refuse un repertoire qui n est pas une archive", async () => {
    const vide = await mkdtemp(join(tmpdir(), "mmarchive-vide-"));
    await expect(
      anonymizeArchive({ archiveDir: vide, outDir: sortie, logger: silent }),
    ).rejects.toThrow(/manifest.json est introuvable/);
    await rm(vide, { recursive: true, force: true });
  });
});

describe("l archive produite", () => {
  it("passe sa propre verification", async () => {
    await anonymiser();
    const report = await verifyArchive({ archiveDir: sortie, checkBlobs: true });
    const echecs = report.results.filter((r) => r.severity === "error");
    expect(echecs.map((e) => `${e.label} ${e.detail ?? ""}`)).toEqual([]);
  });

  it("ne contient plus aucun identifiant d origine, nulle part", async () => {
    await anonymiser();
    const entrees = await readdir(sortie, { recursive: true, withFileTypes: true });
    for (const entree of entrees) {
      if (!entree.isFile()) continue;
      const contenu = await readFile(join(entree.parentPath, entree.name), "utf8");
      for (const identifiant of [ALICE, BOB, ORPHELIN]) {
        expect(contenu, `${entree.name} porte encore un identifiant`).not.toContain(identifiant);
      }
      expect(contenu, `${entree.name} porte encore un nom de compte`).not.toContain("alice.martin");
    }
  });
});

describe("buildIdentityTable", () => {
  it("rend des identifiants de la forme attendue par le format", async () => {
    const table = buildIdentityTable([ALICE, BOB]);
    for (const identite of table.values()) {
      expect(isMattermostId(identite.uid)).toBe(true);
      expect(identite.username).toBe(identite.pseudonyme.toLowerCase());
    }
  });

  it("n attribue jamais deux fois le meme identifiant", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `user-${String(i)}`);
    const table = buildIdentityTable(ids);
    expect(new Set([...table.values()].map((i) => i.uid)).size).toBe(2000);
    expect(new Set([...table.values()].map((i) => i.pseudonyme)).size).toBe(2000);
  });

  it("ne derive pas l identifiant de celui d origine", () => {
    // Une derivation, meme salee, laisserait une correspondance reconstituable
    // par qui retrouverait le sel. Un tirage n a rien a retrouver.
    const a = buildIdentityTable([ALICE]).get(ALICE);
    const b = buildIdentityTable([ALICE]).get(ALICE);
    expect(a?.uid).not.toBe(b?.uid);
  });
});
