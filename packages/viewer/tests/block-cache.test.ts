import { describe, expect, it } from "vitest";
import { BlockCache, type ReadBackend } from "../web/src/lite/block-cache.js";

/** Source deterministe : l octet a la position n vaut n modulo 251. */
function makeBackend(size: number): ReadBackend & { readonly calls: number[][] } {
  const calls: number[][] = [];
  return {
    size,
    label: "test",
    calls,
    read(offset, length) {
      calls.push([offset, length]);
      const end = Math.min(offset + length, size);
      const out = new Uint8Array(Math.max(0, end - offset));
      for (let i = 0; i < out.length; i += 1) out[i] = (offset + i) % 251;
      return out;
    },
  };
}

function expectBytes(bytes: Uint8Array, offset: number): void {
  for (let i = 0; i < bytes.length; i += 1) {
    expect(bytes[i], `octet ${String(offset + i)}`).toBe((offset + i) % 251);
  }
}

const BLOCK = 64 * 1024;

describe("cache de blocs", () => {
  it("rend exactement les octets demandes", () => {
    const backend = makeBackend(1_000_000);
    const cache = new BlockCache(backend);
    for (const [offset, length] of [
      [0, 10],
      [4096, 4096],
      [BLOCK - 5, 10],
      [123_456, 789],
    ]) {
      const bytes = cache.read(offset ?? 0, length ?? 0);
      expect(bytes.length).toBe(length);
      expectBytes(bytes, offset ?? 0);
    }
  });

  it("sert plusieurs pages voisines avec une seule lecture", () => {
    // C est tout l interet du regroupement : SQLite lit par pages de 4 Ko, et
    // les demander une par une ferait une requete par page sur un lien distant.
    const backend = makeBackend(1_000_000);
    const cache = new BlockCache(backend);
    for (let page = 0; page < 16; page += 1) cache.read(page * 4096, 4096);
    expect(backend.calls).toHaveLength(1);
    expect(cache.stats.reads).toBe(1);
    expect(cache.stats.hits).toBe(15);
  });

  it("ne relit pas un bloc deja servi", () => {
    const backend = makeBackend(1_000_000);
    const cache = new BlockCache(backend);
    cache.read(0, 100);
    cache.read(50, 100);
    expect(backend.calls).toHaveLength(1);
  });

  it("assemble une lecture qui traverse plusieurs blocs", () => {
    const backend = makeBackend(1_000_000);
    const cache = new BlockCache(backend);
    const bytes = cache.read(BLOCK - 100, 200);
    expect(bytes.length).toBe(200);
    expectBytes(bytes, BLOCK - 100);
    expect(backend.calls).toHaveLength(2);
  });

  it("ne demande jamais au dela de la fin", () => {
    const size = BLOCK + 1000;
    const backend = makeBackend(size);
    const cache = new BlockCache(backend);
    cache.read(size - 10, 10);
    for (const [offset, length] of backend.calls) {
      expect((offset ?? 0) + (length ?? 0)).toBeLessThanOrEqual(size);
    }
  });

  it("rend une lecture courte en fin de fichier plutot que de completer", () => {
    // SQLite distingue une lecture courte d une erreur : lui rendre des octets
    // inventes lui ferait lire une page qui n existe pas.
    const size = 100;
    const cache = new BlockCache(makeBackend(size));
    const bytes = cache.read(90, 50);
    expect(bytes.length).toBe(10);
    expectBytes(bytes, 90);
  });

  it("evince les blocs les plus anciens sans depasser son plafond", () => {
    const backend = makeBackend(4096 * BLOCK);
    const cache = new BlockCache(backend);
    for (let block = 0; block < 700; block += 1) cache.read(block * BLOCK, 16);
    expect(cache.stats.blocks).toBeLessThanOrEqual(512);
    // Le plus ancien a ete evince : le relire refait une lecture.
    const avant = backend.calls.length;
    cache.read(0, 16);
    expect(backend.calls.length).toBe(avant + 1);
  });

  it("expose la taille de la source", () => {
    expect(new BlockCache(makeBackend(12_345)).size).toBe(12_345);
  });
});
