import { describe, expect, it } from "vitest";
import {
  appliquerCompletion,
  completionEnCours,
  filtrerSuggestions,
  MAX_SUGGESTIONS,
  type Suggestion,
} from "../web/src/ui/completion.js";

describe("ce que la saisie attend", () => {
  it("reconnait un modificateur en cours de frappe", () => {
    const c = completionEnCours("from:ali", 8);
    expect(c?.modificateur).toBe("from");
    expect(c?.prefixe).toBe("ali");
  });

  it("propose des la frappe du deux-points, sans attendre une lettre", () => {
    const c = completionEnCours("in:", 3);
    expect(c?.modificateur).toBe("in");
    expect(c?.prefixe).toBe("");
  });

  it("ne propose rien pour un mot ordinaire", () => {
    expect(completionEnCours("bonjour", 7)).toBeUndefined();
    expect(completionEnCours("truc:machin", 11)).toBeUndefined();
  });

  it("ne propose plus rien une fois le terme termine par une espace", () => {
    expect(completionEnCours("from:alice ", 11)).toBeUndefined();
  });

  it("regarde a gauche du curseur, pas la fin du champ", () => {
    // Quelqu un qui revient corriger au milieu attend des propositions pour le
    // mot ou il se trouve, pas pour le dernier qu il a tape.
    const texte = "from:ali in:general";
    const c = completionEnCours(texte, 8);
    expect(c?.modificateur).toBe("from");
    expect(c?.prefixe).toBe("ali");
  });

  it("accepte la casse que l utilisateur emploie", () => {
    expect(completionEnCours("From:ali", 8)?.modificateur).toBe("from");
  });

  it("ne confond pas un modificateur avec la fin d un autre mot", () => {
    // « platform:ali » n est pas « from:ali ».
    expect(completionEnCours("platform:ali", 12)).toBeUndefined();
  });
});

describe("l insertion", () => {
  it("remplace le fragment et pose le curseur derriere", () => {
    const c = completionEnCours("from:ali", 8);
    if (c === undefined) throw new Error("completion attendue");
    const { texte, position } = appliquerCompletion("from:ali", c, "alice.martin");
    expect(texte).toBe("from:alice.martin ");
    expect(position).toBe(texte.length);
  });

  it("preserve ce qui suit le curseur", () => {
    const texte = "from:ali in:general";
    const c = completionEnCours(texte, 8);
    if (c === undefined) throw new Error("completion attendue");
    expect(appliquerCompletion(texte, c, "alice.martin").texte).toBe(
      "from:alice.martin in:general",
    );
  });

  it("n ajoute pas une seconde espace", () => {
    const texte = "from:ali suite";
    const c = completionEnCours(texte, 8);
    if (c === undefined) throw new Error("completion attendue");
    expect(appliquerCompletion(texte, c, "alice").texte).toBe("from:alice suite");
  });
});

describe("le classement des propositions", () => {
  const candidats: Suggestion[] = [
    { valeur: "jean.martin", libelle: "Jean Martin" },
    { valeur: "martin.dupont", libelle: "Martin Dupont" },
    { valeur: "alice", libelle: "Alice" },
  ];

  it("met le plus court devant, a prefixe egal", () => {
    // Taper le debut d un nom precis ne doit pas faire remonter un homonyme plus
    // long en premiere position, celle que la touche Entree valide.
    const homonymes: Suggestion[] = [
      { valeur: "startup-nosgestesclimat", libelle: "" },
      { valeur: "startup-ngc-dev", libelle: "" },
      { valeur: "startup-ngc-actions", libelle: "" },
    ];
    expect(filtrerSuggestions(homonymes, "startup-n").map((s) => s.valeur)).toEqual([
      "startup-ngc-dev",
      "startup-ngc-actions",
      "startup-nosgestesclimat",
    ]);
  });

  it("met devant ce qui commence par le prefixe", () => {
    // La premiere proposition est celle que la touche Entree valide : si elle
    // est rarement la bonne, l autocompletion coute plus qu elle ne rapporte.
    expect(filtrerSuggestions(candidats, "martin").map((s) => s.valeur)).toEqual([
      "martin.dupont",
      "jean.martin",
    ]);
  });

  it("cherche aussi dans le libelle, pas seulement dans la valeur", () => {
    expect(filtrerSuggestions(candidats, "Jean").map((s) => s.valeur)).toEqual(["jean.martin"]);
  });

  it("rend le debut de la liste quand rien n est tape", () => {
    expect(filtrerSuggestions(candidats, "")).toHaveLength(3);
  });

  it("s arrete a un nombre lisible", () => {
    const beaucoup = Array.from({ length: 50 }, (_, i) => ({
      valeur: `compte${String(i)}`,
      libelle: `Compte ${String(i)}`,
    }));
    expect(filtrerSuggestions(beaucoup, "compte")).toHaveLength(MAX_SUGGESTIONS);
    expect(filtrerSuggestions(beaucoup, "")).toHaveLength(MAX_SUGGESTIONS);
  });
});
