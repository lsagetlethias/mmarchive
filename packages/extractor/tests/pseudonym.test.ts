import { describe, expect, it } from "vitest";
import { assignPseudonyms, CAPACITE, PREFIXE } from "../src/redact/pseudonym.js";

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
      tous.some((p) => /^Anon-(Alouette|Fougere|Brume|Loutre)-(Vive|Discrete|Franche)$/.test(p)),
    ).toBe(true);
    expect(
      tous.some((p) => /^Anon-(Basalte|Renard|Orage|Quartz)-(Vif|Discret|Franc)$/.test(p)),
    ).toBe(true);
    // Aucun nom feminin ne doit porter une forme masculine, ni l inverse.
    expect(
      tous.filter((p) => /^Anon-(Alouette|Fougere|Brume|Loutre)-(Vif|Discret|Franc)\b/.test(p)),
    ).toEqual([]);
  });

  it("fait varier l adjectif des les premiers pseudonymes", () => {
    // Faire avancer l adjectif seulement apres un tour complet des noms donnait
    // le meme adjectif a tout le monde sur une petite archive : dix personnes,
    // dix fois « Agile ». Lisible seulement en apparence.
    const dix = [...assignPseudonyms(ids(10)).values()];
    const adjectifs = new Set(dix.map((p) => p.split("-")[2]));
    expect(adjectifs.size).toBe(10);
  });

  it("puise dans tout son vocabulaire plutot que dans une poignee de noms", () => {
    const suite = [...assignPseudonyms(ids(200)).values()];
    const noms = new Set(suite.map((p) => p.split("-")[1]));
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
    // Une distribution qui suivrait l ordre d entree se rejouerait sans le sel :
    // il suffirait de posseder la liste des comptes. Porte sur la suite entiere
    // plutot que sur un element, qui retomberait a son rang d origine une fois
    // sur deux cents et ferait echouer ce test au hasard.
    const table = assignPseudonyms(ids(200));
    const attribues = [...table.values()];
    const rangs = ids(200).map((id) => attribues.indexOf(table.get(id) ?? ""));
    expect(rangs.every((rang, entree) => rang === entree)).toBe(false);
  });

  it("ne rend rien qui ressemble a un nom de personne", () => {
    // La forme nom plus adjectif ne suffisait pas : sur ce vocabulaire, 868
    // combinaisons sur 5 050 se lisaient comme une identite, « Jade Humble » ou
    // « Ambre Fertile », plusieurs noms de choses etant aussi des prenoms. Le
    // prefixe regle la question par la forme plutot que par une liste de mots.
    for (const p of assignPseudonyms(ids(300)).values()) {
      expect(p).toMatch(/^Anon-[A-Z][a-z]+-[A-Z][a-z]+(-\d+)?$/);
    }
  });

  it("porte sa marque sur chaque pseudonyme, sans exception", () => {
    const tous = [...assignPseudonyms(ids(CAPACITE + 200)).values()];
    expect(tous.every((p) => p.startsWith(PREFIXE))).toBe(true);
    // Aucun ne doit pouvoir se lire comme un prenom suivi d un nom.
    expect(tous.filter((p) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(p))).toEqual([]);
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
