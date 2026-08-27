import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countNdjsonLines,
  NdjsonParseError,
  NdjsonReadError,
  NdjsonSerializeError,
  NdjsonWriteError,
  NdjsonWriter,
  readNdjson,
} from "../src/ndjson.js";

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-ndjson-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function pathIn(...segments: readonly string[]): string {
  return join(workDir, ...segments);
}

async function collect<T>(source: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

async function rawContent(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

describe("NdjsonWriter.open", () => {
  it("distingue un fichier absent d un fichier illisible en mode append", async () => {
    // Traiter les deux pareil ferait echouer l ouverture plus loin, sur un
    // message qui ne designerait plus la cause.
    const directory = join(workDir, "un-repertoire");
    await mkdir(directory, { recursive: true });
    await expect(NdjsonWriter.open(directory, { append: true })).rejects.toThrow(NdjsonWriteError);
  });

  it("cree les repertoires parents manquants", async () => {
    const target = pathIn("archive", "posts", "canal.ndjson");
    const writer = await NdjsonWriter.open(target);
    await writer.write({ id: "a" });
    await writer.close();

    expect(await rawContent(target)).toBe('{"id":"a"}\n');
  });

  it("tronque le fichier existant par defaut", async () => {
    const target = pathIn("posts.ndjson");
    await writeFile(target, '{"ancien":true}\n', "utf8");

    const writer = await NdjsonWriter.open(target);
    await writer.write({ nouveau: true });
    await writer.close();

    expect(await rawContent(target)).toBe('{"nouveau":true}\n');
  });

  it("conserve le contenu existant en mode append", async () => {
    const target = pathIn("posts.ndjson");
    const premier = await NdjsonWriter.open(target);
    await premier.writeMany([{ n: 1 }, { n: 2 }]);
    await premier.close();

    const second = await NdjsonWriter.open(target, { append: true });
    await second.write({ n: 3 });
    await second.close();

    expect(await rawContent(target)).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(second.count).toBe(1);
    expect(await countNdjsonLines(target)).toBe(3);
  });
});

describe("NdjsonWriter.count", () => {
  it("part de zero et suit les ecritures unitaires et par lot", async () => {
    const target = pathIn("posts.ndjson");
    const writer = await NdjsonWriter.open(target);

    expect(writer.count).toBe(0);
    await writer.write({ n: 1 });
    expect(writer.count).toBe(1);
    await writer.writeMany([{ n: 2 }, { n: 3 }, { n: 4 }]);
    expect(writer.count).toBe(4);
    await writer.writeMany([]);
    expect(writer.count).toBe(4);

    await writer.close();
    expect(await countNdjsonLines(target)).toBe(4);
  });

  it("ne compte que les lignes de l instance courante meme en append", async () => {
    const target = pathIn("posts.ndjson");
    const premier = await NdjsonWriter.open(target);
    await premier.writeMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await premier.close();

    const second = await NdjsonWriter.open(target, { append: true });
    await second.write({ n: 4 });
    await second.close();

    expect(premier.count).toBe(3);
    expect(second.count).toBe(1);
  });
});

describe("NdjsonWriter.writeMany", () => {
  it("produit exactement le meme fichier qu une boucle de write", async () => {
    const records = Array.from({ length: 200 }, (_, index) => ({
      index,
      texte: `post ${String(index)}`,
    }));

    const parLot = pathIn("lot.ndjson");
    const writerLot = await NdjsonWriter.open(parLot);
    await writerLot.writeMany(records);
    await writerLot.close();

    const parBoucle = pathIn("boucle.ndjson");
    const writerBoucle = await NdjsonWriter.open(parBoucle);
    for (const record of records) {
      await writerBoucle.write(record);
    }
    await writerBoucle.close();

    expect(await rawContent(parLot)).toBe(await rawContent(parBoucle));
  });

  it("supporte un lot assez gros pour depasser le highWaterMark et declencher drain", async () => {
    const target = pathIn("gros-lot.ndjson");
    const records = Array.from({ length: 20_000 }, (_, index) => ({
      id: `post-${String(index)}`,
      message: "x".repeat(64),
    }));

    const writer = await NdjsonWriter.open(target);
    await writer.writeMany(records);
    await writer.close();

    expect(writer.count).toBe(20_000);
    expect(await countNdjsonLines(target)).toBe(20_000);
  });

  it("supporte des dizaines de milliers d ecritures unitaires successives", async () => {
    const target = pathIn("flux.ndjson");
    const writer = await NdjsonWriter.open(target);
    for (let index = 0; index < 20_000; index += 1) {
      await writer.write({ index, message: "contenu de remplissage".repeat(4) });
    }
    await writer.close();

    expect(writer.count).toBe(20_000);
    expect(await countNdjsonLines(target)).toBe(20_000);

    const relus = await collect(readNdjson<{ index: number }>(target));
    expect(relus).toHaveLength(20_000);
    expect(relus[0]?.index).toBe(0);
    expect(relus[19_999]?.index).toBe(19_999);
  });
});

describe("NdjsonWriter et valeurs non serialisables", () => {
  it("refuse undefined, une fonction et un symbole en mentionnant l index 0", async () => {
    const target = pathIn("invalide.ndjson");
    const writer = await NdjsonWriter.open(target);

    for (const valeur of [undefined, () => 1, Symbol("x")]) {
      await expect(writer.write(valeur)).rejects.toBeInstanceOf(NdjsonSerializeError);
    }
    await expect(writer.write(undefined)).rejects.toThrow(/index 0/);

    await writer.close();
    expect(await rawContent(target)).toBe("");
  });

  it("refuse une reference circulaire et un bigint", async () => {
    const target = pathIn("invalide.ndjson");
    const writer = await NdjsonWriter.open(target);

    const circulaire: { self?: unknown } = {};
    circulaire.self = circulaire;
    await expect(writer.write(circulaire)).rejects.toBeInstanceOf(NdjsonSerializeError);
    await expect(writer.write({ taille: 1n })).rejects.toBeInstanceOf(NdjsonSerializeError);

    await writer.close();
    expect(await rawContent(target)).toBe("");
  });

  it("designe l index exact de l enregistrement fautif dans un lot", async () => {
    const target = pathIn("lot-invalide.ndjson");
    const writer = await NdjsonWriter.open(target);

    const erreur = await writer
      .writeMany([{ n: 0 }, { n: 1 }, undefined, { n: 3 }])
      .catch((cause: unknown) => cause);

    expect(erreur).toBeInstanceOf(NdjsonSerializeError);
    expect((erreur as NdjsonSerializeError).index).toBe(2);
    expect((erreur as NdjsonSerializeError).message).toContain("index 2");

    await writer.close();
  });

  it("ne corrompt pas le fichier quand un lot echoue en cours de serialisation", async () => {
    const target = pathIn("partiel.ndjson");
    const writer = await NdjsonWriter.open(target);

    await writer.writeMany([{ n: 1 }, { n: 2 }]);
    await expect(writer.writeMany([{ n: 3 }, 1n, { n: 5 }])).rejects.toBeInstanceOf(
      NdjsonSerializeError,
    );
    await writer.write({ n: 6 });
    await writer.close();

    expect(await rawContent(target)).toBe('{"n":1}\n{"n":2}\n{"n":6}\n');
    expect(writer.count).toBe(3);
  });
});

describe("NdjsonWriter.flush", () => {
  it("rend les lignes visibles pour un autre lecteur sans fermer le flux", async () => {
    const target = pathIn("flush.ndjson");
    const writer = await NdjsonWriter.open(target);

    await writer.writeMany([{ page: 1 }, { page: 2 }]);
    await writer.flush();
    expect(await countNdjsonLines(target)).toBe(2);

    await writer.write({ page: 3 });
    await writer.flush();
    expect(await countNdjsonLines(target)).toBe(3);

    await writer.close();
    expect(await countNdjsonLines(target)).toBe(3);
  });
});

describe("NdjsonWriter.close", () => {
  it("est idempotent et refuse toute ecriture ulterieure", async () => {
    const target = pathIn("ferme.ndjson");
    const writer = await NdjsonWriter.open(target);
    await writer.write({ n: 1 });
    await writer.close();
    await writer.close();

    await expect(writer.write({ n: 2 })).rejects.toBeInstanceOf(NdjsonWriteError);
    await expect(writer.writeMany([{ n: 2 }])).rejects.toBeInstanceOf(NdjsonWriteError);
    await expect(writer.flush()).rejects.toBeInstanceOf(NdjsonWriteError);
    expect(await countNdjsonLines(target)).toBe(1);
  });
});

describe("echappement des sauts de ligne", () => {
  it("ecrit un message multiligne sur une seule ligne physique et le restitue tel quel", async () => {
    const target = pathIn("multiligne.ndjson");
    const message = "premiere ligne\ndeuxieme ligne\r\ntroisieme\ttabulee";

    const writer = await NdjsonWriter.open(target);
    await writer.writeMany([{ message }, { message: "suivant" }]);
    await writer.close();

    const brut = await rawContent(target);
    expect(brut.split("\n")).toHaveLength(3);
    expect(brut).not.toContain("premiere ligne\n");
    expect(brut).toContain("\\n");
    expect(brut).toContain("\\r");
    expect(brut).toContain("\\t");

    const relus = await collect(readNdjson<{ message: string }>(target));
    expect(relus).toHaveLength(2);
    expect(relus[0]?.message).toBe(message);
  });
});

describe("readNdjson", () => {
  it("ne rend rien sur un fichier vide", async () => {
    const target = pathIn("vide.ndjson");
    await writeFile(target, "", "utf8");

    expect(await collect(readNdjson(target))).toEqual([]);
    expect(await countNdjsonLines(target)).toBe(0);
  });

  it("ne rend rien sur un fichier ne contenant que des lignes vides", async () => {
    const target = pathIn("blanc.ndjson");
    await writeFile(target, "\n\n   \n\t\n\r\n", "utf8");

    expect(await collect(readNdjson(target))).toEqual([]);
    expect(await countNdjsonLines(target)).toBe(0);
  });

  it("lit la derniere ligne d un fichier sans saut de ligne final", async () => {
    const target = pathIn("sans-fin.ndjson");
    await writeFile(target, '{"n":1}\n{"n":2}', "utf8");

    expect(await collect(readNdjson(target))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await countNdjsonLines(target)).toBe(2);
  });

  it("ignore les lignes vides intercalees", async () => {
    const target = pathIn("intercale.ndjson");
    await writeFile(target, '{"n":1}\n\n   \n{"n":2}\n\n\n{"n":3}', "utf8");

    expect(await collect(readNdjson(target))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await countNdjsonLines(target)).toBe(3);
  });

  it("supporte les fins de ligne CRLF", async () => {
    const target = pathIn("crlf.ndjson");
    await writeFile(target, '{"n":1}\r\n{"n":2}\r\n', "utf8");

    expect(await collect(readNdjson(target))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await countNdjsonLines(target)).toBe(2);
  });

  it("restitue accents et emojis a travers les frontieres de blocs de lecture", async () => {
    const target = pathIn("utf8.ndjson");
    const records = Array.from({ length: 5_000 }, (_, index) => ({
      index,
      message: `Compte rendu numero ${String(index)} : reunion prevue jeudi 🎉🚀 中文 emoji ✅ accents eaiou`,
    }));

    const writer = await NdjsonWriter.open(target);
    await writer.writeMany(records);
    await writer.close();

    const relus = await collect(readNdjson<{ index: number; message: string }>(target));
    expect(relus).toHaveLength(5_000);
    expect(relus).toEqual(records);
    expect(await countNdjsonLines(target)).toBe(5_000);
  });

  it("restitue une ligne tres longue sans la tronquer", async () => {
    const target = pathIn("longue.ndjson");
    const enorme = "abcde🚀".repeat(200_000);

    const writer = await NdjsonWriter.open(target);
    await writer.writeMany([{ court: "avant" }, { enorme }, { court: "apres" }]);
    await writer.close();

    const relus = await collect(readNdjson<{ enorme?: string; court?: string }>(target));
    expect(relus).toHaveLength(3);
    expect(relus[1]?.enorme).toHaveLength(enorme.length);
    expect(relus[1]?.enorme).toBe(enorme);
    expect(relus[2]?.court).toBe("apres");
  });

  it("leve une erreur mentionnant le numero de ligne physique sur une ligne invalide", async () => {
    const target = pathIn("casse.ndjson");
    await writeFile(target, '{"n":1}\n\n{ceci n est pas du json}\n{"n":3}\n', "utf8");

    const erreur = await collect(readNdjson(target)).catch((cause: unknown) => cause);

    expect(erreur).toBeInstanceOf(NdjsonParseError);
    expect((erreur as NdjsonParseError).lineNumber).toBe(3);
    expect((erreur as NdjsonParseError).message).toContain("Ligne 3");
    expect((erreur as NdjsonParseError).filePath).toBe(target);
  });

  it("leve une erreur claire et non un ENOENT brut sur un fichier inexistant", async () => {
    const target = pathIn("absent.ndjson");

    const erreur = await collect(readNdjson(target)).catch((cause: unknown) => cause);

    expect(erreur).toBeInstanceOf(NdjsonReadError);
    expect((erreur as NdjsonReadError).message).toContain("n existe pas");
    expect((erreur as NdjsonReadError).message).not.toContain("ENOENT");
    expect((erreur as NdjsonReadError).filePath).toBe(target);
  });

  it("leve une erreur claire quand le chemin designe un repertoire", async () => {
    const erreur = await collect(readNdjson(workDir)).catch((cause: unknown) => cause);

    expect(erreur).toBeInstanceOf(NdjsonReadError);
    expect((erreur as NdjsonReadError).message).toContain("ne designe pas un fichier");
  });

  it("libere le fichier quand l iteration est interrompue avant la fin", async () => {
    const target = pathIn("interrompu.ndjson");
    const writer = await NdjsonWriter.open(target);
    await writer.writeMany(Array.from({ length: 1_000 }, (_, index) => ({ index })));
    await writer.close();

    let premier: { index: number } | undefined;
    for await (const record of readNdjson<{ index: number }>(target)) {
      premier = record;
      break;
    }

    expect(premier?.index).toBe(0);
    expect(await collect(readNdjson(target))).toHaveLength(1_000);
  });

  it("preserve les valeurs JSON qui ne sont pas des objets", async () => {
    const target = pathIn("scalaires.ndjson");
    await writeFile(target, '1\n"texte"\nnull\ntrue\n[1,2]\n', "utf8");

    expect(await collect(readNdjson(target))).toEqual([1, "texte", null, true, [1, 2]]);
  });
});

describe("countNdjsonLines", () => {
  it("compte les lignes non vides sans desserialiser, meme invalides", async () => {
    const target = pathIn("melange.ndjson");
    await writeFile(target, '{"n":1}\n\npas du json\n   \n{"n":2}', "utf8");

    expect(await countNdjsonLines(target)).toBe(3);
  });

  it("leve une erreur claire sur un fichier inexistant", async () => {
    const target = pathIn("absent.ndjson");

    await expect(countNdjsonLines(target)).rejects.toBeInstanceOf(NdjsonReadError);
    await expect(countNdjsonLines(target)).rejects.toThrow(/n existe pas/);
  });

  it("recoupe le compteur du writer sur un gros volume", async () => {
    const target = pathIn("volume.ndjson");
    const writer = await NdjsonWriter.open(target);
    for (let page = 0; page < 20; page += 1) {
      await writer.writeMany(
        Array.from({ length: 500 }, (_, index) => ({
          id: `post-${String(page)}-${String(index)}`,
          message: "🎯 message avec accents et emojis pour peser quelques octets",
        })),
      );
      await writer.flush();
    }
    await writer.close();

    expect(writer.count).toBe(10_000);
    expect(await countNdjsonLines(target)).toBe(10_000);
  });
});

describe("separateurs de ligne unicode", () => {
  it("ne coupe pas une ligne sur U+2028 ni U+2029", async () => {
    // Constate sur une archive reelle : JSON.stringify n echappe pas ces
    // caracteres, legaux dans une chaine JSON, mais readline les traite comme
    // des fins de ligne. Onze occurrences suffisaient a faire passer un fichier
    // sain pour corrompu.
    const path = join(workDir, "separateurs.ndjson");
    const writer = await NdjsonWriter.open(path);
    await writer.write({ id: "a", message: "avant\u2028apres" });
    await writer.write({ id: "b", message: "para\u2029graphe" });
    await writer.write({ id: "c", message: "normal" });
    await writer.close();

    const records: { id: string; message: string }[] = [];
    for await (const rec of readNdjson<{ id: string; message: string }>(path)) {
      records.push(rec);
    }

    expect(records).toHaveLength(3);
    expect(records[0]?.message).toBe("avant\u2028apres");
    expect(records[1]?.message).toBe("para\u2029graphe");
    expect(await countNdjsonLines(path)).toBe(3);
  });

  it("compte les memes lignes que le lecteur en presence de U+2028", async () => {
    const path = join(workDir, "coherence.ndjson");
    const writer = await NdjsonWriter.open(path);
    for (let i = 0; i < 20; i++) {
      await writer.write({ i, message: `ligne\u2028${String(i)}\u2029fin` });
    }
    await writer.close();

    let read = 0;
    for await (const record of readNdjson(path)) {
      void record;
      read += 1;
    }
    expect(read).toBe(20);
    expect(await countNdjsonLines(path)).toBe(20);
  });

  it("preserve un retour chariot a l interieur d un message", async () => {
    const path = join(workDir, "cr.ndjson");
    const writer = await NdjsonWriter.open(path);
    await writer.write({ message: "avec\r\nretour" });
    await writer.close();

    const records: { message: string }[] = [];
    for await (const rec of readNdjson<{ message: string }>(path)) records.push(rec);
    expect(records[0]?.message).toBe("avec\r\nretour");
  });
});
