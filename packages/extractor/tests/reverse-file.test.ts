import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReverseFileError,
  type ReverseLinesOptions,
  reverseLines,
} from "../src/archive/reverse-file.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmarchive-reverse-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface RunResult {
  readonly count: number;
  readonly output: string;
}

async function run(content: string, options?: ReverseLinesOptions): Promise<RunResult> {
  const source = join(workDir, "source.part");
  const destination = join(workDir, "destination.ndjson");
  await writeFile(source, content, "utf8");
  const count = await reverseLines(source, destination, options);
  return { count, output: await readFile(destination, "utf8") };
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

function inverseNaivement(contenu: string): readonly string[] {
  return contenu
    .split("\n")
    .map((ligne) => (ligne.endsWith("\r") ? ligne.slice(0, -1) : ligne))
    .filter((ligne) => ligne.length > 0)
    .reverse()
    .map((ligne) => `${ligne}\n`);
}

describe("reverseLines", () => {
  it("renvoie 0 et produit un fichier de sortie vide quand la source est vide", async () => {
    const { count, output } = await run("");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  it("traite une source d une seule ligne terminee par un retour a la ligne", async () => {
    const { count, output } = await run("seule\n");
    expect(count).toBe(1);
    expect(output).toBe("seule\n");
  });

  it("traite une source d une seule ligne sans retour a la ligne final", async () => {
    const { count, output } = await run("seule");
    expect(count).toBe(1);
    expect(output).toBe("seule\n");
  });

  it("inverse exactement l ordre de trois lignes", async () => {
    const { count, output } = await run("un\ndeux\ntrois\n");
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
  });

  it("fait de la derniere ligne la premiere quand le retour a la ligne final manque", async () => {
    const { count, output } = await run("un\ndeux\ntrois");
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
  });

  it("ignore les lignes vides intercalees, en tete et en queue", async () => {
    const { count, output } = await run("\n\nun\n\n\ndeux\n\ntrois\n\n\n");
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
  });

  it("renvoie 0 pour une source qui ne contient que des retours a la ligne", async () => {
    const { count, output } = await run("\n\n\n\n");
    expect(count).toBe(0);
    expect(output).toBe("");
  });

  it("termine toujours la sortie par un retour a la ligne des qu une ligne est ecrite", async () => {
    const { output } = await run("a\nb");
    expect(output.endsWith("\n")).toBe(true);
    expect(output).toBe("b\na\n");
  });

  it("reconstitue les caracteres multi octets coupes par les frontieres de bloc", async () => {
    const lignes = [
      "hello wörld",
      "🎉🥐 emoji en tete de ligne",
      "漢字とかなとカナ",
      "café ☕ à 5€",
      "mixte : é🎉漢",
      "𝄞 clef de sol sur quatre octets",
    ];
    const content = `${lignes.join("\n")}\n`;

    const bytes = Buffer.from(content, "utf8");
    const coupures: number[] = [];
    for (let position = bytes.length - 7; position > 0; position -= 7) {
      if (isContinuationByte(bytes[position])) {
        coupures.push(position);
      }
    }
    expect(coupures.length).toBeGreaterThan(0);

    const { count, output } = await run(content, { chunkSize: 7 });
    expect(count).toBe(lignes.length);
    expect(output).toBe(`${[...lignes].reverse().join("\n")}\n`);
  });

  it("produit un resultat identique pour toute taille de bloc de 1 a 40 octets", async () => {
    const lignes = ["é🎉漢", "a", "ünïcödé", "🇫🇷 drapeau compose", "𝄞𝄢", "fin"];
    const content = `${lignes.join("\n")}\n`;
    const attendu = `${[...lignes].reverse().join("\n")}\n`;

    for (let chunkSize = 1; chunkSize <= 40; chunkSize += 1) {
      const { count, output } = await run(content, { chunkSize });
      expect(count, `chunkSize=${String(chunkSize)}`).toBe(lignes.length);
      expect(output, `chunkSize=${String(chunkSize)}`).toBe(attendu);
    }
  });

  it("fonctionne avec un bloc d un seul octet", async () => {
    const { count, output } = await run("un\ndeux\ntrois\n", { chunkSize: 1 });
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
  });

  it("recolle une ligne bien plus longue que la taille de bloc", async () => {
    const longue = "é".repeat(500);
    const { count, output } = await run(`court\n${longue}\n`, { chunkSize: 4 });
    expect(count).toBe(2);
    expect(output).toBe(`${longue}\ncourt\n`);
  });

  it("supprime le retour chariot des fins de ligne Windows", async () => {
    const { count, output } = await run("un\r\ndeux\r\ntrois\r\n");
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
    expect(output).not.toContain("\r");
  });

  it("supporte un CRLF coupe en deux par une frontiere de bloc", async () => {
    const { count, output } = await run("un\r\ndeux\r\ntrois", { chunkSize: 1 });
    expect(count).toBe(3);
    expect(output).toBe("trois\ndeux\nun\n");
    expect(output).not.toContain("\r");
  });

  it("ignore les lignes Windows vides reduites a un simple retour chariot", async () => {
    const { count, output } = await run("un\r\n\r\ndeux\r\n");
    expect(count).toBe(2);
    expect(output).toBe("deux\nun\n");
  });

  it("inverse 20 000 lignes numerotees en preservant le compteur", async () => {
    const lignes = Array.from(
      { length: 20_000 },
      (_, index) => `ligne-${String(index).padStart(5, "0")}`,
    );
    const content = `${lignes.join("\n")}\n`;

    const { count, output } = await run(content, { chunkSize: 997 });
    expect(count).toBe(20_000);
    const obtenues = output.split("\n");
    expect(obtenues.pop()).toBe("");
    expect(obtenues).toHaveLength(20_000);
    expect(obtenues[0]).toBe("ligne-19999");
    expect(obtenues[19_999]).toBe("ligne-00000");
    expect(obtenues).toEqual([...lignes].reverse());
  });

  it("remet des posts NDJSON pagines du plus recent au plus ancien en create_at croissant", async () => {
    const createdAt = [1_718_000_000_500, 1_718_000_000_300, 1_718_000_000_100];
    const content = `${createdAt.map((value) => JSON.stringify({ id: String(value), create_at: value })).join("\n")}\n`;

    const { count, output } = await run(content, { chunkSize: 13 });
    expect(count).toBe(3);
    const timestamps = output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { create_at: number }).create_at);
    expect(timestamps).toEqual([...createdAt].reverse());
  });

  it("echoue avec un message clair quand la source n existe pas", async () => {
    const source = join(workDir, "absent.part");
    const destination = join(workDir, "destination.ndjson");

    await expect(reverseLines(source, destination)).rejects.toThrow(ReverseFileError);
    await expect(reverseLines(source, destination)).rejects.toThrow(/introuvable/);
    await expect(stat(destination)).rejects.toThrow();
  });

  it("echoue quand la source est un repertoire", async () => {
    await expect(reverseLines(workDir, join(workDir, "destination.ndjson"))).rejects.toThrow(
      ReverseFileError,
    );
  });

  it("refuse une taille de bloc nulle, negative ou fractionnaire", async () => {
    const source = join(workDir, "source.part");
    const destination = join(workDir, "destination.ndjson");
    await writeFile(source, "un\ndeux\n", "utf8");

    for (const chunkSize of [0, -1, 1.5, Number.NaN]) {
      await expect(reverseLines(source, destination, { chunkSize })).rejects.toThrow(
        /Taille de bloc invalide/,
      );
    }
  });

  it("ecrase une destination existante au lieu de l allonger", async () => {
    const source = join(workDir, "source.part");
    const destination = join(workDir, "destination.ndjson");
    await writeFile(destination, "residu\nd un ancien passage\n", "utf8");
    await writeFile(source, "un\ndeux\n", "utf8");

    const count = await reverseLines(source, destination);
    expect(count).toBe(2);
    expect(await readFile(destination, "utf8")).toBe("deux\nun\n");
  });
  it("preserve octet pour octet une ligne qui n est pas de l UTF-8 valide", async () => {
    const source = join(workDir, "latin1.part");
    const destination = join(workDir, "destination.ndjson");
    // 0xe9 est "e accent aigu" en latin-1 : a lui seul ce n est pas une sequence UTF-8 valide
    await writeFile(source, Buffer.from([0x61, 0x0a, 0xe9, 0x0a, 0x62, 0x0a]));

    const count = await reverseLines(source, destination, { chunkSize: 2 });

    expect(count).toBe(3);
    expect([...(await readFile(destination))]).toEqual([0x62, 0x0a, 0xe9, 0x0a, 0x61, 0x0a]);
  });

  it("refuse d ecrire la sortie par dessus la source", async () => {
    const source = join(workDir, "source.part");
    await writeFile(source, "un\ndeux\n", "utf8");

    await expect(reverseLines(source, source)).rejects.toThrow(ReverseFileError);
    await expect(reverseLines(source, source)).rejects.toThrow(/meme fichier/);
    expect(await readFile(source, "utf8")).toBe("un\ndeux\n");
  });

  it("refuse une destination qui est un lien symbolique vers la source", async () => {
    const source = join(workDir, "source.part");
    const lien = join(workDir, "lien.ndjson");
    await writeFile(source, "un\ndeux\n", "utf8");
    await symlink(source, lien);

    await expect(reverseLines(source, lien)).rejects.toThrow(/meme fichier/);
    expect(await readFile(source, "utf8")).toBe("un\ndeux\n");
  });

  it("ne cree aucune destination quand la source n est pas un fichier regulier", async () => {
    const destination = join(workDir, "destination.ndjson");

    await expect(reverseLines(workDir, destination)).rejects.toThrow(/fichier regulier/);
    await expect(stat(destination)).rejects.toThrow();
  });

  it("laisse intacte une destination preexistante quand la source est invalide", async () => {
    const destination = join(workDir, "destination.ndjson");
    await writeFile(destination, "contenu precieux\n", "utf8");

    await expect(reverseLines(workDir, destination)).rejects.toThrow(ReverseFileError);
    expect(await readFile(destination, "utf8")).toBe("contenu precieux\n");
  });

  it("signale la destination fautive quand son repertoire parent n existe pas", async () => {
    const source = join(workDir, "source.part");
    const destination = join(workDir, "absent", "destination.ndjson");
    await writeFile(source, "un\ndeux\ntrois\n", "utf8");

    const echec: unknown = await reverseLines(source, destination).catch((error: unknown) => error);

    expect(echec).toBeInstanceOf(ReverseFileError);
    expect((echec as ReverseFileError).message).toContain(destination);
    expect((echec as ReverseFileError).cause).toBeInstanceOf(Error);
  });

  it("ne supprime pas un repertoire porte par le chemin de destination", async () => {
    const source = join(workDir, "source.part");
    const destination = join(workDir, "repertoire");
    await writeFile(source, "un\ndeux\n", "utf8");
    await mkdir(destination);

    await expect(reverseLines(source, destination)).rejects.toThrow(ReverseFileError);
    expect((await stat(destination)).isDirectory()).toBe(true);
  });

  it("ne supprime pas une destination qu elle n a pas pu ouvrir", async () => {
    const source = join(workDir, "source.part");
    const destination = join(workDir, "lien-casse.ndjson");
    await writeFile(source, "un\ndeux\n", "utf8");
    await symlink(join(workDir, "cible-absente", "fichier"), destination);

    await expect(reverseLines(source, destination)).rejects.toThrow(ReverseFileError);
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  });

  it("donne le meme resultat qu une inversion naive sur des contenus et blocs pseudo aleatoires", async () => {
    const alphabet = [
      "a",
      "b",
      " ",
      "\n",
      "\n",
      "\r\n",
      "e",
      "\u{1f389}",
      "\u6f22",
      "\r",
      "\u20ac",
    ];
    let graine = 0x5eed_1234;
    const suivant = (): number => {
      graine = (graine * 1_664_525 + 1_013_904_223) >>> 0;
      return graine / 0x1_0000_0000;
    };

    for (let essai = 0; essai < 80; essai += 1) {
      let contenu = "";
      const longueur = Math.floor(suivant() * 60);
      for (let index = 0; index < longueur; index += 1) {
        contenu += alphabet[Math.floor(suivant() * alphabet.length)] ?? "";
      }
      const chunkSize = 1 + Math.floor(suivant() * 24);
      const repere = `essai=${String(essai)} chunkSize=${String(chunkSize)} contenu=${JSON.stringify(contenu)}`;

      const attendu = inverseNaivement(contenu);
      const { count, output } = await run(contenu, { chunkSize });

      expect(output, repere).toBe(attendu.join(""));
      expect(count, repere).toBe(attendu.length);
    }
  });
});
