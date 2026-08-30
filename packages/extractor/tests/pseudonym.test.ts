import { describe, expect, it } from "vitest";
import { assignPseudonyms, CAPACITE } from "../src/redact/pseudonym.js";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `user-${String(i)}`);

describe("assignPseudonyms", () => {
  it("donne un pseudonyme a chaque identifiant", () => {
    const table = assignPseudonyms(ids(50));
    expect(table.size).toBe(50);
    for (const id of ids(50)) expect(table.get(id)).toBeTruthy();
  });

  it("n attribue jamais deux fois le meme, meme a grande echelle", () => {
    // Deux personnes qui partagent un pseudonyme voient leurs propos fusionner :
    // c est une faute plus grave que de ne pas anonymiser du tout.
    const table = assignPseudonyms(ids(4000));
    expect(new Set(table.values()).size).toBe(4000);
  });

  it("tient au dela de son vocabulaire plutot que de se repeter", () => {
    const table = assignPseudonyms(ids(CAPACITE + 500));
    expect(new Set(table.values()).size).toBe(CAPACITE + 500);
  });

  it("accorde l adjectif au genre du nom", () => {
    const tous = [...assignPseudonyms(ids(CAPACITE)).values()];
    // Un accord rate se verrait sur des paires impossibles en francais.
    expect(
      tous.some((p) => /^(Alouette|Fougere|Brume|Loutre) (Vive|Discrete|Franche)$/.test(p)),
    ).toBe(true);
    expect(tous.some((p) => /^(Basalte|Renard|Orage|Quartz) (Vif|Discret|Franc)$/.test(p))).toBe(
      true,
    );
    expect(tous.some((p) => /^\w+ (Vive|Discrete|Franche|Legere|Serieuse)$/.test(p))).toBe(true);
    // Aucun nom feminin ne doit porter une forme masculine, ni l inverse.
    expect(
      tous.filter((p) => /^(Alouette|Fougere|Brume|Loutre) (Vif|Discret|Franc)\b/.test(p)),
    ).toEqual([]);
  });

  it("fait varier l adjectif des les premiers pseudonymes", () => {
    // Faire avancer l adjectif seulement apres un tour complet des noms donnait
    // le meme adjectif a tout le monde sur une petite archive : dix personnes,
    // dix fois « Agile ». Lisible seulement en apparence.
    const dix = [...assignPseudonyms(ids(10)).values()];
    const adjectifs = new Set(dix.map((p) => p.split(" ")[1]));
    expect(adjectifs.size).toBe(10);
  });

  it("ne repete ni nom ni adjectif entre deux pseudonymes voisins", () => {
    const suite = [...assignPseudonyms(ids(200)).values()];
    const noms = new Set(suite.map((p) => p.split(" ")[0]));
    expect(noms.size).toBeGreaterThan(90);
  });

  it("change de correspondance a chaque execution", () => {
    // Le sel est tire au hasard et jamais rendu : sans lui, un simple hachage de
    // l identifiant se renverse par qui possede la liste des comptes.
    const a = assignPseudonyms(ids(200));
    const b = assignPseudonyms(ids(200));
    const identiques = ids(200).filter((id) => a.get(id) === b.get(id)).length;
    expect(identiques).toBeLessThan(20);
  });

  it("ne suit pas l ordre des identifiants", () => {
    // Une distribution qui suivrait l ordre naturel se rejouerait sans le sel.
    const table = assignPseudonyms(ids(200));
    const premier = table.get("user-0");
    const table2 = assignPseudonyms(ids(200));
    expect(premier).not.toBe(table2.get("user-0"));
  });

  it("ne rend rien qui ressemble a un nom de personne", () => {
    // Un generateur de noms realistes attribuerait des identites existantes :
    // preter les propos de quelqu un au nom d une autre personne est pire que
    // de ne pas anonymiser.
    for (const p of assignPseudonyms(ids(300)).values()) {
      expect(p).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/);
    }
  });

  it("traite une entree vide sans broncher", () => {
    expect(assignPseudonyms([]).size).toBe(0);
  });

  it("ne compte qu une fois un identifiant repete", () => {
    expect(assignPseudonyms(["a", "a", "b"]).size).toBe(2);
  });

  it("offre de quoi couvrir une instance entiere", () => {
    // L archive de reference porte 3 277 comptes.
    expect(CAPACITE).toBeGreaterThan(4000);
  });
});
