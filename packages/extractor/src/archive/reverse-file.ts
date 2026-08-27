import { once } from "node:events";
import { createWriteStream, type Stats, type WriteStream } from "node:fs";
import { type FileHandle, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const NEWLINE = Buffer.from([LINE_FEED]);

export interface ReverseLinesOptions {
  /** Taille des blocs lus depuis la fin, en octets. Defaut: 1 Mio. */
  readonly chunkSize?: number;
}

export class ReverseFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReverseFileError";
  }
}

/**
 * Ecrit dans destinationPath les lignes non vides de sourcePath, en ordre inverse.
 * Renvoie le nombre de lignes ecrites.
 */
export async function reverseLines(
  sourcePath: string,
  destinationPath: string,
  options?: ReverseLinesOptions,
): Promise<number> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new ReverseFileError(
      `Taille de bloc invalide : ${String(chunkSize)}. Attendu un entier superieur ou egal a 1.`,
    );
  }
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw new ReverseFileError(sameFileMessage(sourcePath));
  }

  const handle = await openSource(sourcePath);
  try {
    const size = await measureSource(handle, sourcePath, destinationPath);
    return await writeReversed(handle, sourcePath, destinationPath, size, chunkSize);
  } finally {
    // Un echec de fermeture ne doit pas masquer le diagnostic reel.
    await handle.close().catch(() => undefined);
  }
}

function sameFileMessage(sourcePath: string): string {
  return `Source et destination designent le meme fichier : ${sourcePath}. L inversion detruirait la source.`;
}

async function openSource(sourcePath: string): Promise<FileHandle> {
  try {
    return await open(sourcePath, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new ReverseFileError(`Fichier source introuvable : ${sourcePath}`, { cause: error });
    }
    throw new ReverseFileError(`Lecture impossible du fichier source : ${sourcePath}`, {
      cause: error,
    });
  }
}

/**
 * Valide la source avant toute ouverture de la destination : createWriteStream tronque a
 * l ouverture, un controle fait apres detruirait une destination preexistante alors meme
 * que la source est inexploitable.
 */
async function measureSource(
  handle: FileHandle,
  sourcePath: string,
  destinationPath: string,
): Promise<number> {
  let stats: Stats;
  try {
    stats = await handle.stat();
  } catch (error) {
    throw new ReverseFileError(`Lecture impossible du fichier source : ${sourcePath}`, {
      cause: error,
    });
  }
  if (!stats.isFile()) {
    throw new ReverseFileError(`La source n est pas un fichier regulier : ${sourcePath}`);
  }
  // La comparaison de chemins ne voit ni lien symbolique ni lien physique, et un numero
  // d inode nul signale un systeme de fichiers qui ne le renseigne pas.
  if (stats.ino !== 0 && (await isSameFile(stats, destinationPath))) {
    throw new ReverseFileError(sameFileMessage(sourcePath));
  }
  return stats.size;
}

async function isSameFile(source: Stats, destinationPath: string): Promise<boolean> {
  try {
    const destination = await stat(destinationPath);
    return destination.dev === source.dev && destination.ino === source.ino;
  } catch {
    return false;
  }
}

async function writeReversed(
  handle: FileHandle,
  sourcePath: string,
  destinationPath: string,
  size: number,
  chunkSize: number,
): Promise<number> {
  const output = createWriteStream(destinationPath);
  let destinationCreated = false;
  output.once("open", () => {
    destinationCreated = true;
  });
  let outputFailure: Error | undefined;
  output.on("error", (error: Error) => {
    outputFailure ??= error;
  });
  const failOnOutputError = (): void => {
    if (outputFailure !== undefined) {
      throw new ReverseFileError(`Ecriture impossible dans ${destinationPath}.`, {
        cause: outputFailure,
      });
    }
  };
  const discardPartialOutput = async (): Promise<void> => {
    // Une sortie tronquee est indiscernable d une sortie complete pour un lecteur : ne rien
    // laisser vaut mieux qu un fichier partiel d apparence valide. On ne supprime que ce
    // qu on a soi meme ouvert, jamais une entree preexistante qu on n a pas pu ecrire.
    if (!destinationCreated) {
      return;
    }
    await rm(destinationPath, { force: true }).catch(() => undefined);
  };

  try {
    let written = 0;
    let position = size;
    // Octets deja lus appartenant a une ligne dont le debut se trouve dans un bloc pas
    // encore lu. Un caractere UTF-8 peut etre coupe par une frontiere de bloc : on ne
    // recolle jamais qu une ligne complete, jamais un bloc isole.
    const pending: Buffer[] = [];

    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const block = await readBlock(handle, sourcePath, position, readSize);

      let segmentEnd = block.length;
      for (let index = block.length - 1; index >= 0; index -= 1) {
        if (block[index] !== LINE_FEED) {
          continue;
        }
        const head = block.subarray(index + 1, segmentEnd);
        let line = head;
        if (segmentEnd === block.length && pending.length > 0) {
          line = Buffer.concat([head, ...pending]);
          pending.length = 0;
        }
        failOnOutputError();
        if (await writeLine(output, line)) {
          written += 1;
        }
        segmentEnd = index;
      }

      if (segmentEnd > 0) {
        pending.unshift(block.subarray(0, segmentEnd));
      }
    }

    failOnOutputError();
    if (await writeLine(output, Buffer.concat(pending))) {
      written += 1;
    }

    failOnOutputError();
    output.end();
    // "close" et pas "finish" : a "finish" le descripteur de la destination est encore
    // ouvert, ce qui fait echouer un renommage ou une suppression sous Windows.
    await once(output, "close");
    return written;
  } catch (error) {
    await destroyOutput(output);
    await discardPartialOutput();
    throw toReverseFileError(error, outputFailure, sourcePath, destinationPath);
  }
}

async function destroyOutput(output: WriteStream): Promise<void> {
  if (output.closed) {
    return;
  }
  output.destroy();
  try {
    await once(output, "close");
  } catch {
    // destroy() peut refaire surface une erreur deja enregistree par outputFailure.
  }
}

function toReverseFileError(
  error: unknown,
  outputFailure: Error | undefined,
  sourcePath: string,
  destinationPath: string,
): ReverseFileError {
  if (error instanceof ReverseFileError) {
    return error;
  }
  if (outputFailure !== undefined) {
    return new ReverseFileError(`Ecriture impossible dans ${destinationPath}.`, {
      cause: outputFailure,
    });
  }
  return new ReverseFileError(`Echec de l inversion de ${sourcePath} vers ${destinationPath}.`, {
    cause: error,
  });
}

/**
 * read() positionne peut rendre moins d octets que demande. Un bloc partiel decalerait
 * toutes les frontieres de ligne suivantes, donc on remplit jusqu au compte exact.
 */
async function readBlock(
  handle: FileHandle,
  sourcePath: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const block = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(block, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw new ReverseFileError(`Fichier source tronque pendant la lecture : ${sourcePath}`);
    }
    filled += bytesRead;
  }
  return block;
}

async function writeLine(output: WriteStream, raw: Buffer): Promise<boolean> {
  const end =
    raw.length > 0 && raw[raw.length - 1] === CARRIAGE_RETURN ? raw.length - 1 : raw.length;
  if (end === 0) {
    return false;
  }
  // Les octets partent tels quels : un aller-retour par une chaine remplacerait toute
  // sequence UTF-8 invalide par U+FFFD et altererait la ligne en silence.
  if (!output.write(Buffer.concat([raw.subarray(0, end), NEWLINE], end + 1))) {
    await once(output, "drain");
  }
  return true;
}

function hasErrnoCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
