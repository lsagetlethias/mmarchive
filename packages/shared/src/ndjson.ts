import { Buffer } from "node:buffer";
import type { WriteStream } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const NEWLINE = "\n";
const LINE_FEED = 0x0a;
const READ_BUFFER_SIZE = 64 * 1024;

/** Espaces ASCII hors saut de ligne. Tout octet >= 0x80 est du contenu UTF-8. */
const BLANK_BYTES = new Set([0x09, 0x0b, 0x0c, 0x0d, 0x20]);

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : "cause inconnue";
}

function causeCode(cause: unknown): string | undefined {
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
}

export class NdjsonWriteError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string, options?: ErrorOptions) {
    super(`Ecriture NDJSON impossible sur ${filePath} : ${detail}`, options);
    this.name = "NdjsonWriteError";
    this.filePath = filePath;
  }
}

export class NdjsonSerializeError extends Error {
  readonly index: number;

  constructor(index: number, detail: string, options?: ErrorOptions) {
    super(`Enregistrement d index ${String(index)} non serialisable en JSON : ${detail}`, options);
    this.name = "NdjsonSerializeError";
    this.index = index;
  }
}

export class NdjsonReadError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string, options?: ErrorOptions) {
    super(`Lecture NDJSON impossible sur ${filePath} : ${detail}`, options);
    this.name = "NdjsonReadError";
    this.filePath = filePath;
  }
}

export class NdjsonParseError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(filePath: string, lineNumber: number, detail: string, options?: ErrorOptions) {
    super(`Ligne ${String(lineNumber)} invalide dans ${filePath} : ${detail}`, options);
    this.name = "NdjsonParseError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
  }
}

/**
 * JSON.stringify est declare comme renvoyant string alors qu il renvoie
 * undefined pour undefined, une fonction ou un symbole.
 */
function stringifyOrUndefined(record: unknown): string | undefined {
  return JSON.stringify(record);
}

/**
 * La serialisation complete precede toute ecriture : un lot dont un seul
 * enregistrement est fautif ne doit laisser aucune ligne partielle sur disque.
 */
function serializeRecord(record: unknown, index: number): string {
  let json: string | undefined;
  try {
    json = stringifyOrUndefined(record);
  } catch (cause) {
    throw new NdjsonSerializeError(index, describeCause(cause), { cause });
  }
  if (json === undefined) {
    throw new NdjsonSerializeError(
      index,
      "la valeur ne produit aucun JSON (undefined, fonction ou symbole)",
    );
  }
  return json;
}

export interface NdjsonWriterOptions {
  /** Ouvre en append plutot qu en ecrasement. Defaut: false. */
  readonly append?: boolean;
}

export class NdjsonWriter {
  readonly #filePath: string;
  readonly #handle: FileHandle;
  readonly #stream: WriteStream;
  #count = 0;
  #closed = false;
  #failure: Error | undefined;
  #drain: Promise<void> | undefined;
  #lastWrite: Promise<void> = Promise.resolve();

  private constructor(filePath: string, handle: FileHandle, stream: WriteStream) {
    this.#filePath = filePath;
    this.#handle = handle;
    this.#stream = stream;
    // Sans ecouteur permanent, une erreur de flux devient une exception non
    // rattrapable qui tue le process au lieu de remonter a l appelant.
    stream.on("error", (error: Error) => {
      this.#failure ??= error;
    });
  }

  /** Cree les repertoires parents si necessaire, puis ouvre le flux. */
  static async open(filePath: string, options?: NdjsonWriterOptions): Promise<NdjsonWriter> {
    const append = options?.append ?? false;
    try {
      await mkdir(dirname(filePath), { recursive: true });
    } catch (cause) {
      throw new NdjsonWriteError(
        filePath,
        `creation du repertoire parent impossible (${describeCause(cause)})`,
        { cause },
      );
    }

    let handle: FileHandle;
    try {
      handle = await open(filePath, append ? "a" : "w");
    } catch (cause) {
      throw new NdjsonWriteError(filePath, `ouverture impossible (${describeCause(cause)})`, {
        cause,
      });
    }

    // autoClose reste actif : avec autoClose false le flux ne relache jamais sa
    // reference sur le FileHandle et handle.close() ne se resout plus jamais.
    const stream = handle.createWriteStream({ encoding: "utf8" });
    return new NdjsonWriter(filePath, handle, stream);
  }

  /** Nombre de lignes ecrites par cette instance. */
  get count(): number {
    return this.#count;
  }

  /** Serialise et ecrit un enregistrement suivi de \n. Respecte le backpressure. */
  async write(record: unknown): Promise<void> {
    this.#assertUsable();
    const payload = serializeRecord(record, 0) + NEWLINE;
    await this.#writeChunk(payload);
    this.#count += 1;
  }

  /** Ecrit un lot. Doit etre plus efficace qu une boucle de write(). */
  async writeMany(records: readonly unknown[]): Promise<void> {
    this.#assertUsable();
    if (records.length === 0) {
      return;
    }
    const payload = records.map(serializeRecord).join(NEWLINE) + NEWLINE;
    await this.#writeChunk(payload);
    this.#count += records.length;
  }

  /** Force l ecriture sur disque. Appele apres une page de posts pour que --resume soit fiable. */
  async flush(): Promise<void> {
    this.#assertUsable();
    await this.#lastWrite;
    try {
      await this.#handle.sync();
    } catch (cause) {
      throw new NdjsonWriteError(this.#filePath, `fsync impossible (${describeCause(cause)})`, {
        cause,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    let streamError: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        this.#stream.once("error", reject);
        this.#stream.end(() => {
          resolve();
        });
      });
    } catch (error) {
      streamError = error;
    }

    await this.#handle.close();

    const failure = streamError ?? this.#failure;
    if (failure !== undefined) {
      throw new NdjsonWriteError(this.#filePath, describeCause(failure), { cause: failure });
    }
  }

  async #writeChunk(chunk: string): Promise<void> {
    let settle!: (error: Error | null | undefined) => void;
    const flushed = new Promise<void>((resolve, reject) => {
      settle = (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
    });
    // Seul flush() attend cette promesse : sans rattrapage neutre, un echec
    // d ecriture remonterait comme rejet non gere.
    flushed.catch(() => undefined);
    this.#lastWrite = flushed;

    const accepted = this.#stream.write(chunk, settle);
    if (!accepted) {
      await this.#waitForDrain();
    }
  }

  /**
   * Une seule paire d ecouteurs partagee par tous les appelants en attente :
   * a 200 000 ecritures, un once() par appel sature la limite d ecouteurs.
   */
  #waitForDrain(): Promise<void> {
    const stream = this.#stream;
    this.#drain ??= new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        stream.off("error", onError);
        this.#drain = undefined;
        resolve();
      };
      const onError = (error: Error): void => {
        stream.off("drain", onDrain);
        this.#drain = undefined;
        reject(error);
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
    });
    return this.#drain;
  }

  #assertUsable(): void {
    if (this.#closed) {
      throw new NdjsonWriteError(this.#filePath, "le flux est deja ferme");
    }
    if (this.#failure !== undefined) {
      throw new NdjsonWriteError(this.#filePath, describeCause(this.#failure), {
        cause: this.#failure,
      });
    }
  }
}

async function openForRead(filePath: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (cause) {
    const code = causeCode(cause);
    if (code === "ENOENT") {
      throw new NdjsonReadError(filePath, "le fichier n existe pas", { cause });
    }
    if (code === "EACCES") {
      throw new NdjsonReadError(filePath, "acces refuse", { cause });
    }
    throw new NdjsonReadError(filePath, `ouverture impossible (${describeCause(cause)})`, {
      cause,
    });
  }

  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new NdjsonReadError(filePath, "le chemin ne designe pas un fichier");
  }
  return handle;
}

// T est un simple typage au site d appel : le contenu d une archive relue n est
// pas validable ici, la validation zod se fait chez l appelant.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseLine<T>(line: string, filePath: string, lineNumber: number): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new NdjsonParseError(filePath, lineNumber, describeCause(cause), { cause });
  }
  return parsed as T;
}

/**
 * Lit un fichier NDJSON ligne par ligne. Les lignes vides sont ignorees.
 *
 * Le decoupage se fait STRICTEMENT sur le saut de ligne U+000A, jamais via
 * readline. JSON.stringify n echappe pas U+2028 (LINE SEPARATOR) ni U+2029
 * (PARAGRAPH SEPARATOR), qui sont des caracteres legaux dans une chaine JSON et
 * apparaissent reellement dans des messages copies depuis un traitement de
 * texte. Or readline les traite comme des fins de ligne : il coupait donc des
 * enregistrements valides en deux, et le fragment resultant echouait au parsing.
 * Constate sur une archive reelle, ou onze occurrences suffisaient a faire
 * passer un fichier sain pour corrompu.
 */
export async function* readNdjson<T = unknown>(
  filePath: string,
): AsyncGenerator<T, void, undefined> {
  const handle = await openForRead(filePath);
  const stream = handle.createReadStream({ encoding: "utf8", autoClose: false });
  let pending = "";
  let lineNumber = 0;

  const emit = function* (raw: string): Generator<T> {
    lineNumber += 1;
    // On ne retire que le retour chariot d une fin de ligne Windows et les
    // espaces ASCII : String.trim supprimerait aussi U+2028, qui peut
    // legitimement terminer une chaine JSON.
    const line = raw.replace(/\r$/, "").replace(/^[ \t]+|[ \t]+$/g, "");
    if (line.length === 0) return;
    yield parseLine<T>(line, filePath, lineNumber);
  };

  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        yield* emit(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    }
    if (pending.length > 0) yield* emit(pending);
  } finally {
    stream.destroy();
    await handle.close();
  }
}

/** Compte les lignes non vides sans desserialiser. Utile pour verifier une reprise. */
export async function countNdjsonLines(filePath: string): Promise<number> {
  const handle = await openForRead(filePath);
  const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
  let count = 0;
  let lineHasContent = false;

  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      for (const byte of buffer.subarray(0, bytesRead)) {
        if (byte === LINE_FEED) {
          if (lineHasContent) {
            count += 1;
          }
          lineHasContent = false;
        } else if (!BLANK_BYTES.has(byte)) {
          lineHasContent = true;
        }
      }
    }
  } finally {
    await handle.close();
  }

  // Derniere ligne sans saut de ligne final.
  if (lineHasContent) {
    count += 1;
  }
  return count;
}
