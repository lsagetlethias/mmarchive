import { describe, expect, it } from "vitest";
import { adressesDe, identifiantsDe, mentionsDe, telephonesDe } from "../src/redact/measure.js";

describe("mentionsDe", () => {
  it("ancre la mention et ignore les adresses", () => {
    expect(mentionsDe("bonjour @alice").formes).toEqual(["alice"]);
    expect(mentionsDe("ecris a bob@example.org").formes).toEqual([]);
  });
  it("retire la ponctuation finale, comme Mattermost", () => {
    expect(mentionsDe("merci @alice.").formes).toEqual(["alice"]);
    expect(mentionsDe("@bob.martin a repondu").formes).toEqual(["bob.martin"]);
  });
  it("compte les mentions collectives a part", () => {
    const m = mentionsDe("@channel et @alice");
    expect(m.collectives).toBe(1);
    expect(m.formes).toEqual(["alice"]);
  });
  it("garde un tiret bas final, qui fait partie du nom", () => {
    expect(mentionsDe("@vermeer_ a quitte").formes).toEqual(["vermeer_"]);
  });
});

describe("adressesDe", () => {
  it("trouve les adresses", () => {
    expect(adressesDe("ecris a a.b@ex.org ou c@d.fr")).toEqual(["a.b@ex.org", "c@d.fr"]);
  });
  it("ne prend pas une mention pour une adresse", () => {
    expect(adressesDe("@alice bonjour")).toEqual([]);
  });
});

describe("mentions et adresses ne se recouvrent pas", () => {
  it("ne voit pas de mention dans une partie locale d adresse", () => {
    // L ancrage doit couvrir toute la classe admise avant l arobase, `%` et `+`
    // compris : six adresses de l archive de reference produisaient sinon une
    // mention, qui aurait ete remplacee au milieu de l adresse.
    for (const adresse of ["a+b@ex.org", "a%b@ex.org", "a.b@ex.org", "a-b@ex.org"]) {
      expect(mentionsDe(adresse).formes, adresse).toEqual([]);
    }
  });
});

describe("telephonesDe", () => {
  it("reconnait les formes francaises courantes", () => {
    expect(telephonesDe("06 12 34 56 78")).toBe(1);
    expect(telephonesDe("+33 6 12 34 56 78")).toBe(1);
    expect(telephonesDe("06.12.34.56.78")).toBe(1);
  });
  it("ne ramasse pas un fragment d identifiant numerique", () => {
    expect(telephonesDe("reference 0612345678901234")).toBe(0);
  });

  it("exige un separateur coherent, les formes hybrides n existant pas", () => {
    // 5 994 des 7 812 detections de l archive de reference etaient des
    // identifiants de ce type dans des offres d emploi.
    expect(telephonesDe("poste def_01-23456789")).toBe(0);
    expect(telephonesDe("uuid b2d-b0e3-4048-bb02-1234")).toBe(0);
    expect(telephonesDe("06 12.34-56 78")).toBe(0);
  });
});

describe("identifiantsDe", () => {
  it("trouve un identifiant isole et pas un fragment", () => {
    expect(identifiantsDe(`voir ${"a".repeat(26)} ici`)).toEqual(["a".repeat(26)]);
    expect(identifiantsDe("x".repeat(30))).toEqual([]);
  });

  it("garde les repetitions, l appelant en comptant des occurrences", () => {
    // Dedupliquer ici ferait annoncer moins d occurrences qu il n y en a.
    const id = "a".repeat(26);
    expect(identifiantsDe(`${id} puis ${id}`)).toHaveLength(2);
  });
});
