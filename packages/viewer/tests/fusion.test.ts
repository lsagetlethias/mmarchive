import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUSION_LIMIT,
  DEFAULT_VECTOR_WEIGHT,
  fuse,
  type ScoredHit,
} from "../src/rag/fusion.js";

const hit = (fragment: number, score: number): ScoredHit => ({ fragment, score });

describe("fuse", () => {
  it("garde les fragments trouves par une seule moitie", () => {
    // C est la contrainte qu on rate le plus souvent : ne garder que
    // l intersection reviendrait a perdre ce que l hybride cherche a gagner,
    // le fragment que seul un mot rare designe.
    const out = fuse([hit(1, 10)], [hit(2, 0.9)]);
    expect(out.map((h) => h.fragment).sort()).toEqual([1, 2]);
  });

  it("signale les fragments qu une seule moitie a vus", () => {
    const out = fuse([hit(1, 10), hit(2, 5)], [hit(2, 0.9)]);
    const par = new Map(out.map((h) => [h.fragment, h.alone]));
    expect(par.get(1)).toBe(true);
    expect(par.get(2)).toBe(false);
  });

  it("place devant ce que les deux moities designent", () => {
    // Un fragment honorable des deux cotes doit battre un fragment excellent
    // d un seul : c est tout l interet de croiser deux signaux.
    const out = fuse([hit(1, 10), hit(2, 7), hit(9, 0)], [hit(3, 1), hit(2, 0.7), hit(8, 0)], {
      vectorWeight: 0.5,
    });
    expect(out[0]?.fragment).toBe(2);
  });

  it("ramene le dernier de chaque liste au niveau d un absent", () => {
    // Propriete connue de la mise a l echelle par les bornes : le plus faible
    // score devient zero, donc etre vu en derniere position ne vaut pas mieux
    // que ne pas avoir ete vu. C est le champ `alone` qui porte la difference,
    // pas le score.
    const out = fuse([hit(1, 5), hit(2, 9)], [], { vectorWeight: 0 });
    const dernier = out.find((h) => h.fragment === 1);
    expect(dernier?.score).toBe(0);
    expect(dernier?.alone).toBe(true);
  });

  it("respecte le poids demande", () => {
    const surVectoriel = fuse([hit(1, 10), hit(2, 0)], [hit(2, 1), hit(1, 0)], {
      vectorWeight: 0.9,
    });
    expect(surVectoriel[0]?.fragment).toBe(2);
    const surLexical = fuse([hit(1, 10), hit(2, 0)], [hit(2, 1), hit(1, 0)], {
      vectorWeight: 0.1,
    });
    expect(surLexical[0]?.fragment).toBe(1);
  });

  it("met les deux moities sur la meme echelle avant de les melanger", () => {
    // Un bm25 va de zero a quelques dizaines, une similarite cosinus tient dans
    // [-1, 1]. Sans mise a l echelle, le poids annonce ne serait pas applique.
    const out = fuse([hit(1, 1000), hit(2, 0)], [hit(2, 0.9), hit(1, 0)], {
      vectorWeight: 0.5,
    });
    expect(out[0]?.score).toBeCloseTo(0.5, 5);
    expect(out[1]?.score).toBeCloseTo(0.5, 5);
  });

  it("traite des scores tous egaux comme ex aequo, pas comme mauvais", () => {
    // Les mettre a zero effacerait toute une moitie de la fusion des qu elle ne
    // discrimine pas.
    const out = fuse([hit(1, 5), hit(2, 5)], [], { vectorWeight: 0 });
    expect(out.every((h) => h.lexical === 1)).toBe(true);
  });

  it("rend l autre moitie telle quelle quand la premiere est vide", () => {
    const out = fuse([], [hit(3, 0.9), hit(1, 0.5)]);
    expect(out.map((h) => h.fragment)).toEqual([3, 1]);
  });

  it("ne rend rien quand les deux moities sont vides", () => {
    expect(fuse([], [])).toEqual([]);
  });

  it("classe de facon stable, pour que deux executions se comparent", () => {
    const out = fuse([hit(7, 5), hit(3, 5)], [hit(7, 1), hit(3, 1)]);
    expect(out.map((h) => h.fragment)).toEqual([3, 7]);
  });

  it("s arrete au nombre de fragments demande", () => {
    const beaucoup = Array.from({ length: 40 }, (_, i) => hit(i + 1, 40 - i));
    expect(fuse(beaucoup, [], { limit: 5 })).toHaveLength(5);
    expect(fuse(beaucoup, [])).toHaveLength(DEFAULT_FUSION_LIMIT);
  });

  it("refuse un poids hors des bornes plutot que de classer n importe comment", () => {
    expect(() => fuse([], [], { vectorWeight: 1.5 })).toThrow(/entre 0 et 1/);
    expect(() => fuse([], [], { vectorWeight: -1 })).toThrow(/entre 0 et 1/);
    expect(() => fuse([], [], { vectorWeight: Number.NaN })).toThrow(/entre 0 et 1/);
  });

  it("penche par defaut du cote vectoriel", () => {
    expect(DEFAULT_VECTOR_WEIGHT).toBeGreaterThan(0.5);
    expect(DEFAULT_VECTOR_WEIGHT).toBeLessThanOrEqual(0.8);
  });

  it("expose ce que chaque moitie a apporte", () => {
    // Sans cela, un classement surprenant reste inexplicable, et le reglage du
    // poids se ferait a l aveugle.
    const out = fuse([hit(1, 10)], [hit(1, 0.5)]);
    expect(out[0]).toMatchObject({ fragment: 1, lexical: 1, vector: 1, alone: false });
  });
});

describe("entrees invalides", () => {
  it("refuse un score qui n est pas un nombre fini", () => {
    // NaN echappe aux comparaisons : il traverserait le calcul des bornes sans
    // rien declencher, pour ressortir en score fusionne NaN et faire rendre au
    // tri l ordre d arrivee.
    expect(() => fuse([hit(1, Number.NaN)], [])).toThrow(/fragment 1/);
    expect(() => fuse([], [hit(4, Number.POSITIVE_INFINITY)])).toThrow(/fragment 4/);
  });

  it("nomme la moitie fautive", () => {
    expect(() => fuse([hit(1, Number.NaN)], [])).toThrow(/lexical/);
    expect(() => fuse([], [hit(1, Number.NaN)])).toThrow(/vectoriel/);
  });

  it("refuse une limite qui n est pas un entier positif", () => {
    // slice(0, -1) rendrait « tout sauf le dernier », ce que personne n a
    // demande.
    expect(() => fuse([], [], { limit: -1 })).toThrow(/entier positif/);
    expect(() => fuse([], [], { limit: 2.5 })).toThrow(/entier positif/);
    expect(() => fuse([], [], { limit: Number.NaN })).toThrow(/entier positif/);
  });

  it("accepte une limite nulle, qui veut dire zero fragment", () => {
    expect(fuse([hit(1, 5)], [], { limit: 0 })).toEqual([]);
  });
});
