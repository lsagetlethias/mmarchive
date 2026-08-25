import type { PathLike, RmOptions } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_LAYOUT,
  createChannelProgress,
  createEmptyState,
  type ExtractState,
  extractStateSchema,
} from "@mmarchive/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateCorruptedError, StateMismatchError, StateStore } from "../src/archive/state-store.js";

/**
 * Compteur d ecritures atomiques et injection de pannes. Le nombre de rename
 * est la seule mesure fiable du nombre d ecritures reellement declenchees :
 * deux ecritures successives laissent le meme contenu sur disque.
 */
const fsHooks = vi.hoisted(() => ({
  renames: 0,
  renameFailuresLeft: 0,
  rmFails: false,
  renameFailure: "ENOSPC disque plein",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      fsHooks.renames += 1;
      if (fsHooks.renameFailuresLeft > 0) {
        fsHooks.renameFailuresLeft -= 1;
        throw new Error(fsHooks.renameFailure);
      }
      await actual.rename(from, to);
    },
    rm: async (target: PathLike, options?: RmOptions): Promise<void> => {
      if (fsHooks.rmFails) {
        throw new Error("nettoyage refuse");
      }
      await actual.rm(target, options);
    },
  };
});

const EXPECTED = {
  sourceUrl: "https://mm.example.org",
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  optionsFingerprint: "sha256:abc",
};

const INIT = {
  startedAt: "2026-08-24T10:00:00.000Z",
  sourceUrl: EXPECTED.sourceUrl,
  accountId: EXPECTED.accountId,
  optionsFingerprint: EXPECTED.optionsFingerprint,
};

function fakeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let directory: string;
let statePath: string;

beforeEach(async () => {
  fsHooks.renames = 0;
  fsHooks.renameFailuresLeft = 0;
  fsHooks.rmFails = false;
  directory = await mkdtemp(join(tmpdir(), "mmarchive-state-"));
  statePath = join(directory, ARCHIVE_LAYOUT.state);
});

afterEach(async () => {
  fsHooks.renameFailuresLeft = 0;
  fsHooks.rmFails = false;
  await rm(directory, { recursive: true, force: true });
});

async function readState(path = statePath): Promise<ExtractState> {
  const raw = await readFile(path, "utf8");
  return extractStateSchema.parse(JSON.parse(raw));
}

async function temporaryFiles(path = directory): Promise<string[]> {
  const entries = await readdir(path);
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

async function writeRawState(overrides: Partial<ExtractState>): Promise<void> {
  const state: ExtractState = { ...createEmptyState(INIT), ...overrides };
  await writeFile(statePath, JSON.stringify(state), "utf8");
}

describe("create / saveNow / load", () => {
  it("relit un etat equivalent a celui qui vient d etre ecrit", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    store.state.emojis_done = true;
    store.state.attachments_bytes = 4096;
    store.touch();
    await store.saveNow();

    const loaded = await StateStore.load(statePath, EXPECTED, { clock: clock.now });
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toEqual(store.state);
    expect(loaded?.state.version).toBe(1);
  });

  it("conserve la trace des canaux rejoints des le saveNow qui suit le join", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    store.state.joined_channels.push({
      id: "cccccccccccccccccccccccccc",
      name: "tech-archi",
      team_id: "tttttttttttttttttttttttttt",
      joined_at: "2026-08-24T10:02:11.000Z",
      left: false,
    });
    store.touch();
    await store.saveNow();

    const onDisk = await readState();
    expect(onDisk.joined_channels).toHaveLength(1);
    expect(onDisk.joined_channels[0]?.name).toBe("tech-archi");
  });

  it("cree le repertoire parent s il manque encore", async () => {
    const nested = join(directory, "archive", ARCHIVE_LAYOUT.state);
    const store = StateStore.create(nested, INIT);
    await store.saveNow();

    await expect(readState(nested)).resolves.toMatchObject({ source_url: EXPECTED.sourceUrl });
  });

  it("rafraichit updated_at a chaque ecriture, sans toucher a started_at", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    await store.saveNow();
    expect((await readState()).updated_at).toBe("2026-08-24T10:00:00.000Z");

    clock.advance(90_000);
    store.touch();
    await store.saveNow();

    const onDisk = await readState();
    expect(onDisk.updated_at).toBe("2026-08-24T10:01:30.000Z");
    expect(onDisk.started_at).toBe(INIT.startedAt);
  });

  it("close ecrit meme si aucune modification n a suivi la creation", async () => {
    const store = StateStore.create(statePath, INIT);
    await store.close();

    await expect(readState()).resolves.toMatchObject({ account_id: EXPECTED.accountId });
  });

  it("ne laisse aucun fichier temporaire apres une sauvegarde reussie", async () => {
    const store = StateStore.create(statePath, INIT);
    await store.saveNow();
    store.touch();
    await store.saveNow();

    await expect(temporaryFiles()).resolves.toEqual([]);
    await expect(readdir(directory)).resolves.toEqual([ARCHIVE_LAYOUT.state]);
  });

  it("n ecrit pas une seconde fois quand close suit un saveNow sans modification", async () => {
    const store = StateStore.create(statePath, INIT);
    await store.saveNow();
    await store.close();

    expect(fsHooks.renames).toBe(1);
  });
});

describe("load, absence et garde-fous d identite", () => {
  it("renvoie null quand le fichier n existe pas", async () => {
    await expect(StateStore.load(statePath, EXPECTED)).resolves.toBeNull();
  });

  it("refuse un etat produit depuis une autre instance", async () => {
    await writeRawState({ source_url: "https://autre.example.org" });

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateMismatchError);
    expect((error as StateMismatchError).reason).toBe("source_url");
  });

  it("refuse un etat produit par un autre compte", async () => {
    await writeRawState({ account_id: "zzzzzzzzzzzzzzzzzzzzzzzzzz" });

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateMismatchError);
    expect((error as StateMismatchError).reason).toBe("account");
  });

  it("refuse un etat produit avec d autres options", async () => {
    await writeRawState({ options_fingerprint: "sha256:def" });

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateMismatchError);
    expect((error as StateMismatchError).reason).toBe("options");
  });

  it("refuse un etat d une autre version de format, avant tout autre controle", async () => {
    await writeRawState({ version: 99, source_url: "https://autre.example.org" });

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateMismatchError);
    expect((error as StateMismatchError).reason).toBe("version");
  });

  it("annonce une version incompatible plutot qu une corruption quand la forme a change", async () => {
    // Une version 2 aura un schema different : le schema de la version 1 ne peut
    // pas la valider, et dire "fichier corrompu" enverrait l utilisateur au
    // mauvais endroit.
    await writeFile(
      statePath,
      JSON.stringify({ version: 2, started_at: INIT.startedAt, chans: {} }),
      "utf8",
    );

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateMismatchError);
    expect((error as StateMismatchError).reason).toBe("version");
    expect((error as Error).message).toContain("version 2");
  });

  it("accepte un etat dont les quatre verrous correspondent", async () => {
    await writeRawState({});

    await expect(StateStore.load(statePath, EXPECTED)).resolves.toBeInstanceOf(StateStore);
  });

  it("n ecrit rien sur disque pendant un load", async () => {
    await writeRawState({});
    await StateStore.load(statePath, EXPECTED);

    expect(fsHooks.renames).toBe(0);
  });
});

describe("load, etat corrompu", () => {
  it("leve une erreur explicite sur un JSON tronque", async () => {
    await writeFile(statePath, '{"version": 1, "started_at"', "utf8");

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateCorruptedError);
    expect((error as Error).message).toContain("--resume");
    expect((error as Error).message).toContain("JSON invalide");
  });

  it("leve StateCorruptedError sur un fichier vide, cas typique d un crash en pleine ecriture", async () => {
    await writeFile(statePath, "", "utf8");

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateCorruptedError);
    expect((error as StateCorruptedError).filePath).toBe(statePath);
  });

  it("leve StateCorruptedError et non un ZodError brut sur un schema qui ne colle pas", async () => {
    await writeFile(statePath, JSON.stringify({ version: 1, channels: "pas un objet" }), "utf8");

    const error = await StateStore.load(statePath, EXPECTED).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StateCorruptedError);
    expect((error as Error).name).toBe("StateCorruptedError");
    expect((error as Error).message).toContain("--resume");
    expect((error as StateCorruptedError).cause).toBeDefined();
  });

  it("leve StateCorruptedError sur un JSON valide mais scalaire", async () => {
    await writeFile(statePath, "42", "utf8");

    await expect(StateStore.load(statePath, EXPECTED)).rejects.toBeInstanceOf(StateCorruptedError);
  });

  it("remonte telle quelle une erreur systeme qui n est pas une absence de fichier", async () => {
    await mkdir(join(directory, "repertoire"));

    const error = await StateStore.load(join(directory, "repertoire"), EXPECTED).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StateCorruptedError);
    expect(error).not.toBeInstanceOf(StateMismatchError);
  });
});

describe("saveThrottled", () => {
  it("etouffe les appels rapproches mais close ecrit la derniere valeur", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    await store.saveNow();

    for (let index = 1; index <= 50; index += 1) {
      store.state.attachments_bytes = index;
      store.touch();
      clock.advance(10);
      await store.saveThrottled(5_000);
    }

    expect((await readState()).attachments_bytes).toBe(0);

    await store.close();
    expect((await readState()).attachments_bytes).toBe(50);
    expect(fsHooks.renames).toBe(2);
  });

  it("ecrit des que la fenetre est ecoulee", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    await store.saveNow();

    store.state.attachments_bytes = 7;
    store.touch();
    clock.advance(1_000);
    await store.saveThrottled(5_000);
    expect((await readState()).attachments_bytes).toBe(0);

    clock.advance(5_000);
    await store.saveThrottled(5_000);
    expect((await readState()).attachments_bytes).toBe(7);
  });

  it("n ecrit rien quand l etat n a pas ete modifie", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    await store.saveNow();

    clock.advance(60_000);
    await store.saveThrottled(1);

    expect((await readState()).updated_at).toBe("2026-08-24T10:00:00.000Z");
    expect(fsHooks.renames).toBe(1);
  });

  it("ecrit au premier appel, aucune fenetre n ayant encore ete ouverte", async () => {
    const store = StateStore.create(statePath, INIT);
    store.state.emojis_done = true;
    store.touch();
    await store.saveThrottled(60_000);

    expect((await readState()).emojis_done).toBe(true);
  });

  it("ne declenche qu une ecriture quand plusieurs canaux appellent en parallele", async () => {
    // Plusieurs canaux sont extraits de front : leurs saveThrottled tombent dans
    // le meme tick, avant que la premiere ecriture n ait eu le temps de finir.
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => {
        store.updateProgress(`canal-${String(index)}`, { posts_written: index });
        return store.saveThrottled(5_000);
      }),
    );

    expect(fsHooks.renames).toBe(1);
    expect(Object.keys((await readState()).channels)).toHaveLength(12);
  });

  it("etouffe aussi une rafale parallele qui suit une ecriture recente", async () => {
    const clock = fakeClock("2026-08-24T10:00:00.000Z");
    const store = StateStore.create(statePath, INIT, { clock: clock.now });
    await store.saveNow();
    clock.advance(100);

    await Promise.all(
      Array.from({ length: 12 }, () => {
        store.touch();
        return store.saveThrottled(5_000);
      }),
    );

    expect(fsHooks.renames).toBe(1);
  });
});

describe("ecritures concurrentes", () => {
  it("serialise les saveNow simultanes et laisse un JSON complet", async () => {
    const store = StateStore.create(statePath, INIT);

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) => {
        store.state.attachments_bytes = index + 1;
        store.state.fetched_user_ids.push(`user-${String(index)}`);
        store.touch();
        return store.saveNow();
      }),
    );

    const onDisk = await readState();
    expect(onDisk.fetched_user_ids).toHaveLength(25);
    expect(onDisk.attachments_bytes).toBe(25);
    expect(onDisk).toEqual(store.state);
    await expect(temporaryFiles()).resolves.toEqual([]);
  });

  it("close attend les ecritures encore en vol", async () => {
    const store = StateStore.create(statePath, INIT);
    const inFlight = store.saveNow();
    store.state.emojis_done = true;
    store.touch();

    await store.close();
    await inFlight;

    expect((await readState()).emojis_done).toBe(true);
  });
});

describe("echec d ecriture", () => {
  it("nettoie le fichier temporaire et garde l etat a sauvegarder", async () => {
    const blocked = join(directory, "blocage");
    await mkdir(blocked);
    const store = StateStore.create(blocked, INIT);

    await expect(store.saveNow()).rejects.toBeInstanceOf(Error);
    await expect(temporaryFiles()).resolves.toEqual([]);

    await rm(blocked, { recursive: true });
    store.state.emojis_done = true;
    await store.close();

    await expect(readState(blocked)).resolves.toMatchObject({ emojis_done: true });
  });

  it("laisse remonter la cause reelle meme si le nettoyage du temporaire echoue", async () => {
    const store = StateStore.create(statePath, INIT);
    fsHooks.renameFailuresLeft = 1;
    fsHooks.rmFails = true;

    await expect(store.saveNow()).rejects.toThrow(fsHooks.renameFailure);
  });

  it("close reessaie et rejette quand l ecriture en vol a echoue sans qu il le sache", async () => {
    // close peut arriver alors qu une ecriture a deja abaisse le drapeau dirty :
    // si cette ecriture echoue, close doit reprendre la main, pas resoudre sur un
    // etat que personne n a jamais pose sur disque.
    const store = StateStore.create(statePath, INIT);
    fsHooks.renameFailuresLeft = 10;
    const inFlight = store.saveNow().catch((cause: unknown) => cause);
    // Un tick suffit a faire demarrer l ecriture, donc a faire retomber dirty.
    await Promise.resolve();

    await expect(store.close()).rejects.toThrow(fsHooks.renameFailure);
    expect(await inFlight).toBeInstanceOf(Error);
  });

  it("close ecrit finalement quand la panne de l ecriture en vol s est resorbee", async () => {
    const store = StateStore.create(statePath, INIT);
    store.state.emojis_done = true;
    fsHooks.renameFailuresLeft = 1;
    const inFlight = store.saveNow().catch((cause: unknown) => cause);
    await Promise.resolve();

    await store.close();

    expect(await inFlight).toBeInstanceOf(Error);
    expect(fsHooks.renames).toBe(2);
    await expect(readState()).resolves.toMatchObject({ emojis_done: true });
  });
});

describe("progression par canal", () => {
  const channelId = "cccccccccccccccccccccccccc";

  it("cree une entree vierge a la premiere demande", () => {
    const store = StateStore.create(statePath, INIT);
    const progress = store.progressFor(channelId);

    expect(progress).toEqual({
      status: "pending",
      oldest_post_id: null,
      oldest_create_at: null,
      newest_create_at: null,
      posts_written: 0,
      exhausted: false,
      finalized: false,
    });
    expect(Object.keys(store.state.channels)).toEqual([channelId]);
  });

  it("renvoie la meme entree aux appels suivants", () => {
    const store = StateStore.create(statePath, INIT);
    store.updateProgress(channelId, { posts_written: 12 });

    expect(store.progressFor(channelId).posts_written).toBe(12);
    expect(Object.keys(store.state.channels)).toHaveLength(1);
  });

  it("applique le patch sur l entree existante sans en substituer une autre", () => {
    // La boucle d extraction d un canal garde sa progression pendant toute la
    // pagination : un remplacement la laisserait lire un objet orphelin.
    const store = StateStore.create(statePath, INIT);
    const progress = store.progressFor(channelId);

    store.updateProgress(channelId, { status: "in_progress", posts_written: 42 });

    expect(progress.posts_written).toBe(42);
    expect(progress.status).toBe("in_progress");
    expect(store.progressFor(channelId)).toBe(progress);
  });

  it("fusionne le patch sans ecraser les champs absents", () => {
    const store = StateStore.create(statePath, INIT);
    store.updateProgress(channelId, { status: "in_progress", posts_written: 200 });
    store.updateProgress(channelId, { oldest_post_id: "pppppppppppppppppppppppppp" });

    expect(store.progressFor(channelId)).toMatchObject({
      status: "in_progress",
      posts_written: 200,
      oldest_post_id: "pppppppppppppppppppppppppp",
    });
  });

  it("ne prend pas un membre herite d Object.prototype pour une progression existante", () => {
    // Un identifiant de canal vient d un YAML editable a la main : un acces
    // indexe nu sur un objet litteral resoudrait "constructor" sur le prototype
    // et la progression de ce canal ne serait jamais enregistree.
    const store = StateStore.create(statePath, INIT);

    expect(store.progressFor("constructor")).toEqual(createChannelProgress());
    expect(Object.hasOwn(store.state.channels, "constructor")).toBe(true);

    store.updateProgress("constructor", { posts_written: 3 });
    expect(store.progressFor("constructor").posts_written).toBe(3);
  });

  it("conserve le curseur apres un rechargement", async () => {
    const store = StateStore.create(statePath, INIT);
    store.updateProgress(channelId, {
      status: "in_progress",
      oldest_post_id: "pppppppppppppppppppppppppp",
      oldest_create_at: 1_718_000_000_000,
      newest_create_at: 1_756_000_000_000,
      posts_written: 4_200,
    });
    store.updateProgress("dddddddddddddddddddddddddd", { status: "complete", finalized: true });
    await store.close();

    const loaded = await StateStore.load(statePath, EXPECTED);
    expect(loaded?.progressFor(channelId)).toMatchObject({
      oldest_post_id: "pppppppppppppppppppppppppp",
      oldest_create_at: 1_718_000_000_000,
      posts_written: 4_200,
      exhausted: false,
    });
    expect(loaded?.progressFor("dddddddddddddddddddddddddd").finalized).toBe(true);
  });

  it("marque l etat comme a sauvegarder, la reprise depend de ce curseur", async () => {
    const store = StateStore.create(statePath, INIT);
    await store.saveNow();
    store.updateProgress(channelId, { posts_written: 1 });
    await store.close();

    expect((await readState()).channels[channelId]?.posts_written).toBe(1);
  });

  it("ne remet pas a zero la progression d un canal deja charge depuis le disque", async () => {
    const store = StateStore.create(statePath, INIT);
    store.updateProgress(channelId, { status: "in_progress", posts_written: 4_200 });
    await store.close();

    const loaded = await StateStore.load(statePath, EXPECTED);
    expect(loaded?.progressFor(channelId).posts_written).toBe(4_200);
    expect(Object.keys(loaded?.state.channels ?? {})).toEqual([channelId]);
  });
});
