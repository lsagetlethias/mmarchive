import type { ArchiveUser } from "@mmarchive/shared";
import { describe, expect, it } from "vitest";
import {
  construireVocabulaire,
  formesCandidates,
  normaliserForme,
} from "../src/redact/name-vocabulary.js";
import { NIVEAUX, reecritLesFormes, reecritLesNoms } from "../src/redact/niveau.js";

function user(over: Partial<ArchiveUser>): ArchiveUser {
  return {
    id: "u".repeat(26),
    username: "compte",
    nickname: "",
    first_name: "",
    last_name: "",
    position: "",
    roles: "system_user",
    is_bot: false,
    create_at: 1,
    delete_at: 0,
    avatar: null,
    ...over,
  };
}

describe("les formes candidates", () => {
  it("retient toute forme simple, le filtrage par longueur venant apres", () => {
    // Les formes trop courtes restent candidates pour que le compte qui n en a
    // pas d autre apparaisse au rapport comme restant nommable. Les ecarter ici
    // le faisait disparaitre des deux colonnes.
    const formes = formesCandidates(
      user({ first_name: "Ana", last_name: "Durand", nickname: "AD" }),
    );
    expect([...formes].sort()).toEqual(["ad", "ana", "durand"]);
  });

  it("normalise les accents et la casse", () => {
    expect(formesCandidates(user({ first_name: "Stéphane" }))).toEqual(new Set(["stephane"]));
    expect(normaliserForme("  MARTIN ")).toBe("martin");
  });

  it("ecarte les formes composees, le remplacement se faisant mot a mot", () => {
    expect(formesCandidates(user({ nickname: "Jean Pierre" }))).toEqual(new Set());
  });
});

describe("le vocabulaire", () => {
  const substitution = new Map([["u".repeat(26), "Anon-Quartz-Agile"]]);

  it("retient une forme rare et peu frequente", () => {
    const v = construireVocabulaire(
      [user({ last_name: "Durand" })],
      substitution,
      new Map([["durand", 12]]),
      200,
    );
    expect(v.formes.get("durand")).toBe("Anon-Quartz-Agile");
    expect(v.comptesCouverts).toBe(1);
  });

  it("ecarte une forme trop frequente dans le corpus", () => {
    // Le critere decisif, et le seul qui demande de lire l archive : une forme
    // qui parait mille fois n est pas une personne citee mille fois.
    const v = construireVocabulaire(
      [user({ last_name: "Pierre" })],
      substitution,
      new Map([["pierre", 1000]]),
      200,
    );
    expect(v.formes.size).toBe(0);
    expect(v.ecarteesParFrequence).toBe(1);
    expect(v.comptesNonCouverts).toBe(1);
  });

  it("ecarte une forme partagee par trop de comptes", () => {
    // Un prenom porte par six comptes est repandu, pas un identifiant : le
    // remplacer ne protege personne en particulier.
    const beaucoup = Array.from({ length: 6 }, (_, i) =>
      user({ id: String(i).padStart(26, "u"), first_name: "Marie" }),
    );
    const noms = new Map(beaucoup.map((u) => [u.id, `Anon-${u.id.slice(-1)}`]));
    const v = construireVocabulaire(beaucoup, noms, new Map(), 200);
    expect(v.formes.size).toBe(0);
    expect(v.comptesNonCouverts).toBe(6);
  });

  it("compte comme non couvert un compte dont aucune forme n est retenue", () => {
    // C est le chiffre que le rapport doit annoncer : aucun reglage ne couvre
    // tout le monde, et le taire serait promettre ce qu on ne tient pas.
    //
    // « Ana » fait trois lettres, donc rien ne peut la remplacer : ce compte
    // reste nommable en clair et doit apparaitre comme tel.
    const v = construireVocabulaire(
      [user({ first_name: "Ana" }), user({ id: "v".repeat(26), last_name: "Durand" })],
      new Map([["v".repeat(26), "Anon-Basalte-Sobre"]]),
      new Map(),
      200,
    );
    expect(v.comptesCouverts).toBe(1);
    expect(v.comptesNonCouverts).toBe(1);
  });

  it("ne compte pas un compte sans aucun nom au repertoire", () => {
    // L outil ne peut pas le nommer, donc il ne court pas ce risque-la : le
    // faire figurer parmi les restants nommables gonflerait un chiffre que le
    // rapport presente comme un risque.
    const v = construireVocabulaire([user({})], new Map(), new Map(), 200);
    expect(v.comptesCouverts).toBe(0);
    expect(v.comptesNonCouverts).toBe(0);
  });
});

describe("les niveaux", () => {
  it("s emboitent du moins intrusif au plus intrusif", () => {
    expect(NIVEAUX).toEqual(["comptes", "formes", "noms"]);
    expect(reecritLesFormes("comptes")).toBe(false);
    expect(reecritLesFormes("formes")).toBe(true);
    expect(reecritLesFormes("noms")).toBe(true);
    expect(reecritLesNoms("formes")).toBe(false);
    expect(reecritLesNoms("noms")).toBe(true);
  });
});
