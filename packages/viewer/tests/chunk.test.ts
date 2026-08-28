import { describe, expect, it } from "vitest";
import {
  CHUNK_DEFAULTS,
  type ChunkContext,
  type ChunkInput,
  chunkThreads,
  chunkWindows,
} from "../src/rag/chunk.js";

const MINUTE = 60 * 1000;

const context: ChunkContext = {
  channelName: (ch) => `canal-${String(ch)}`,
  userName: (usr) => (usr === null ? "inconnu" : `u${String(usr)}`),
  day: () => "12 mars 2024",
};

let suivant = 1;
function msg(over: Partial<ChunkInput> = {}): ChunkInput {
  suivant += 1;
  return {
    ch: 1,
    rowid: suivant,
    create_at: suivant * MINUTE,
    root: null,
    usr: 1,
    message: "un message",
    ...over,
  };
}

describe("chunkWindows", () => {
  it("regroupe les messages consecutifs en une seule fenetre", () => {
    const out = [...chunkWindows([msg(), msg(), msg()], context)];
    expect(out).toHaveLength(1);
    expect(out[0]?.messages).toBe(3);
    expect(out[0]?.root).toBeNull();
  });

  it("coupe sur un silence plus long que la limite", () => {
    const a = msg({ create_at: 0 });
    const b = msg({ create_at: 31 * MINUTE });
    expect([...chunkWindows([a, b], context)]).toHaveLength(2);
  });

  it("ne coupe pas sur un silence egal a la limite", () => {
    // Strictement superieur : un seuil qui coupe a l egalite rend le reglage de
    // la coupure difficile a raisonner.
    const a = msg({ create_at: 0 });
    const b = msg({ create_at: CHUNK_DEFAULTS.gapMs });
    expect([...chunkWindows([a, b], context)]).toHaveLength(1);
  });

  it("coupe au changement de canal, meme sans silence", () => {
    const a = msg({ ch: 1, create_at: 0 });
    const b = msg({ ch: 2, create_at: 1000 });
    const out = [...chunkWindows([a, b], context)];
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.ch)).toEqual([1, 2]);
  });

  it("coupe au plafond de messages", () => {
    const serie = Array.from({ length: 41 }, (_, i) => msg({ create_at: i * 1000 }));
    const out = [...chunkWindows(serie, context, { maxChars: 1_000_000 })];
    expect(out).toHaveLength(2);
    expect(out[0]?.messages).toBe(40);
    expect(out[1]?.messages).toBe(1);
  });

  it("ne rend rien sur une entree vide", () => {
    expect([...chunkWindows([], context)]).toEqual([]);
  });
});

describe("chunkThreads", () => {
  it("rassemble une racine et ses reponses en un fragment", () => {
    const racine = msg({ rowid: 100, root: null });
    const out = [
      ...chunkThreads(
        [racine, msg({ rowid: 101, root: 100 }), msg({ rowid: 102, root: 100 })],
        context,
      ),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]?.root).toBe(100);
    expect(out[0]?.messages).toBe(3);
  });

  it("separe deux fils qui se suivent", () => {
    const out = [
      ...chunkThreads(
        [
          msg({ rowid: 100, root: null }),
          msg({ rowid: 101, root: 100 }),
          msg({ rowid: 200, root: null }),
          msg({ rowid: 201, root: 200 }),
        ],
        context,
      ),
    ];
    expect(out.map((f) => f.root)).toEqual([100, 200]);
  });

  it("ignore le temps : un fil reste un fil quelle que soit sa duree", () => {
    // C est toute la difference avec une fenetre. Une reponse six mois plus tard
    // appartient a son fil, la decouper la separerait de sa question.
    const out = [
      ...chunkThreads(
        [
          msg({ rowid: 100, root: null, create_at: 0 }),
          msg({ rowid: 101, root: 100, create_at: 180 * 24 * 3600 * 1000 }),
        ],
        context,
      ),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]?.messages).toBe(2);
  });
});

describe("coupure des fragments trop longs", () => {
  it("coupe entre deux messages, jamais au milieu de l un", () => {
    const long = "x".repeat(2000);
    const out = [
      ...chunkWindows([msg({ message: long }), msg({ message: long })], context, {
        maxChars: 2960,
      }),
    ];
    expect(out).toHaveLength(2);
    for (const f of out) expect(f.text).toContain(long);
  });

  it("numerote les morceaux et signale les suites", () => {
    const long = "x".repeat(2000);
    const out = [
      ...chunkWindows([msg({ message: long }), msg({ message: long })], context, {
        maxChars: 2960,
      }),
    ];
    expect(out.map((f) => f.part)).toEqual([0, 1]);
    expect(out[0]?.text).not.toContain("(suite)");
    expect(out[1]?.text).toContain("(suite)");
  });

  it("laisse passer un message seul plus grand que le plafond", () => {
    // Le couper reviendrait a trahir son contenu ; le rejeter, a le rendre
    // introuvable. On le garde entier et on l assume.
    const enorme = "x".repeat(10_000);
    const out = [...chunkWindows([msg({ message: enorme })], context, { maxChars: 2960 })];
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toContain(enorme);
  });
});

describe("texte rendu", () => {
  it("porte un en-tete qui nomme le canal et les participants", () => {
    const out = [...chunkWindows([msg({ usr: 1 }), msg({ usr: 2 }), msg({ usr: 1 })], context)];
    const texte = out[0]?.text ?? "";
    expect(texte.split("\n")[0]).toBe("Canal #canal-1, 12 mars 2024, participants : u1, u2");
  });

  it("prefixe chaque message de son auteur", () => {
    const out = [...chunkWindows([msg({ usr: 7, message: "bonjour" })], context)];
    expect(out[0]?.text).toContain("u7 : bonjour");
  });

  it("collecte les participants sans doublon et dans l ordre d apparition", () => {
    const out = [...chunkWindows([msg({ usr: 3 }), msg({ usr: 1 }), msg({ usr: 3 })], context)];
    expect(out[0]?.users).toEqual([3, 1]);
  });

  it("garde les bornes du fragment, pour pouvoir remonter aux messages", () => {
    const out = [
      ...chunkWindows(
        [msg({ rowid: 10, create_at: 5 }), msg({ rowid: 11, create_at: 9 })],
        context,
      ),
    ];
    expect(out[0]).toMatchObject({ firstId: 10, lastId: 11, firstAt: 5, lastAt: 9 });
  });
});

describe("le plafond porte sur le texte reellement rendu", () => {
  const bavard: ChunkContext = {
    channelName: () => "un-nom-de-canal-particulierement-long-comme-il-en-existe",
    userName: (usr) =>
      usr === null ? "inconnu" : `prenom.nom-de-famille-a-rallonge-${String(usr)}`,
    day: () => "12 mars 2024",
  };

  it("ne produit aucun fragment plus long que le plafond", () => {
    // L en-tete grandit avec le nombre de participants et chaque ligne porte le
    // nom de son auteur : estimer la taille sur le seul message laisserait
    // passer des fragments au dela du plafond.
    const serie = Array.from({ length: 30 }, (_, i) =>
      msg({ usr: i, create_at: i * 1000, message: "x".repeat(60) }),
    );
    const out = [...chunkWindows(serie, bavard, { maxChars: 600 })];
    expect(out.length).toBeGreaterThan(1);
    for (const f of out) expect(f.text.length).toBeLessThanOrEqual(600);
  });

  it("laisse passer le seul cas ou c est impossible, un message trop grand a lui seul", () => {
    const out = [...chunkWindows([msg({ message: "x".repeat(5000) })], bavard, { maxChars: 600 })];
    expect(out).toHaveLength(1);
    expect(out[0]?.text.length).toBeGreaterThan(600);
  });
});

describe("decoupage en flux", () => {
  it("emet un morceau sans attendre la fin d un fil tres long", () => {
    // Un fil de plusieurs dizaines de milliers de messages ne doit pas etre
    // accumule en entier pour etre coupe.
    function* fil(): Generator<ChunkInput> {
      yield msg({ rowid: 1, root: null, message: "x".repeat(1000) });
      for (let i = 2; i <= 100; i += 1) yield msg({ rowid: i, root: 1, message: "x".repeat(1000) });
      throw new Error("le generateur a ete consomme au dela du premier morceau");
    }
    const iterateur = chunkThreads(fil(), context, { maxChars: 2960 });
    const premier = iterateur.next();
    expect(premier.done).toBe(false);
    expect(premier.value?.messages).toBeLessThan(100);
  });
});
