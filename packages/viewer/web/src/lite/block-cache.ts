/**
 * Regroupement des lectures en blocs, independamment de leur provenance.
 *
 * Ce module ne touche a aucune interface du navigateur : c est ce qui permet de
 * l eprouver sans en demarrer un.
 */
export interface ReadBackend {
  readonly size: number;
  /** Lit exactement [offset, offset + length) et rend ce qui existe. */
  read(offset: number, length: number): Uint8Array;
  readonly label: string;
}

/** Taille des blocs demandes a la source. Voir le commentaire de BlockCache. */
const BLOCK_SIZE = 64 * 1024;

/** Nombre de blocs gardes. A 64 Ko le plafond represente environ 32 Mo. */
const MAX_BLOCKS = 512;

/**
 * Regroupe les lectures en blocs et les garde en memoire.
 *
 * SQLite lit par pages de 4 Ko, souvent voisines. Demander chaque page a la
 * source ferait, sur un lien distant, une requete par page : ouvrir un canal en
 * coute une quarantaine. Les servir par blocs de 64 Ko ramene cela a quelques
 * requetes, et le cache absorbe les relectures des pages internes des index,
 * qui sont traversees a chaque requete.
 */
export class BlockCache {
  readonly #backend: ReadBackend;
  readonly #blocks = new Map<number, Uint8Array>();
  #reads = 0;
  #hits = 0;

  constructor(backend: ReadBackend) {
    this.#backend = backend;
  }

  get size(): number {
    return this.#backend.size;
  }

  get stats(): { readonly reads: number; readonly hits: number; readonly blocks: number } {
    return { reads: this.#reads, hits: this.#hits, blocks: this.#blocks.size };
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const position = offset + written;
      const index = Math.floor(position / BLOCK_SIZE);
      const block = this.#block(index);
      const start = position - index * BLOCK_SIZE;
      const take = Math.min(length - written, block.length - start);
      if (take <= 0) break;
      out.set(block.subarray(start, start + take), written);
      written += take;
    }
    return written === length ? out : out.subarray(0, written);
  }

  #block(index: number): Uint8Array {
    const known = this.#blocks.get(index);
    if (known !== undefined) {
      this.#hits += 1;
      // Remise en fin de file : la Map conserve l ordre d insertion, ce qui
      // suffit a evincer le bloc le moins recemment servi.
      this.#blocks.delete(index);
      this.#blocks.set(index, known);
      return known;
    }
    const offset = index * BLOCK_SIZE;
    const length = Math.min(BLOCK_SIZE, this.#backend.size - offset);
    const block = length <= 0 ? new Uint8Array(0) : this.#backend.read(offset, length);
    this.#reads += 1;
    this.#blocks.set(index, block);
    if (this.#blocks.size > MAX_BLOCKS) {
      const oldest = this.#blocks.keys().next();
      if (!oldest.done) this.#blocks.delete(oldest.value);
    }
    return block;
  }
}
