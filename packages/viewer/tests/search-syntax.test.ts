import { describe, expect, it } from "vitest";
import {
  compileSearch,
  parseSearchQuery,
  quoteTerm,
  type SearchResolver,
  timeRangeFor,
} from "../src/query/search-syntax.js";

const resolver: SearchResolver = {
  channelIdByName: (name) => ({ general: 1, "tech-archi": 2 })[name],
  userIdByUsername: (name) => ({ alice: 10, bob: 20 })[name],
};

function compile(input: string, offsetMinutes = 0): ReturnType<typeof compileSearch> {
  return compileSearch(parseSearchQuery(input), resolver, offsetMinutes);
}

function matchOf(input: string): string {
  const result = compile(input);
  if (result.kind !== "ok") throw new Error(`compilation ${result.kind} pour "${input}"`);
  return result.match;
}

describe("analyse de la saisie", () => {
  it("separe les mots et conserve leur ordre", () => {
    const parsed = parseSearchQuery("note de cadrage");
    expect(parsed.include.map((t) => t.text)).toEqual(["note", "de", "cadrage"]);
    expect(parsed.include.every((t) => !t.phrase)).toBe(true);
  });

  it("reconnait une phrase entre guillemets", () => {
    const parsed = parseSearchQuery('"note de cadrage" urgent');
    expect(parsed.include).toEqual([
      { text: "note de cadrage", phrase: true, prefix: false },
      { text: "urgent", phrase: false, prefix: false },
    ]);
  });

  it("reconnait une exclusion, sur un mot comme sur une phrase", () => {
    const parsed = parseSearchQuery('budget -brouillon -"note de cadrage"');
    expect(parsed.include.map((t) => t.text)).toEqual(["budget"]);
    expect(parsed.exclude.map((t) => t.text)).toEqual(["brouillon", "note de cadrage"]);
  });

  it("cumule les modificateurs repetables", () => {
    const parsed = parseSearchQuery("from:alice from:bob in:general in:tech-archi");
    expect(parsed.from).toEqual(["alice", "bob"]);
    expect(parsed.channels).toEqual(["general", "tech-archi"]);
  });

  it("accepte les prefixes @ et ~ des noms", () => {
    const parsed = parseSearchQuery("from:@alice in:~general");
    expect(parsed.from).toEqual(["alice"]);
    expect(parsed.channels).toEqual(["general"]);
  });

  it("nie un modificateur", () => {
    const parsed = parseSearchQuery("-from:alice -in:general");
    expect(parsed.notFrom).toEqual(["alice"]);
    expect(parsed.notChannels).toEqual(["general"]);
    expect(parsed.from).toEqual([]);
  });

  it("reconnait la recherche par prefixe", () => {
    expect(parseSearchQuery("reuni*").include[0]).toEqual({
      text: "reuni",
      phrase: false,
      prefix: true,
    });
    expect(parseSearchQuery('"note de"*').include[0]).toEqual({
      text: "note de",
      phrase: true,
      prefix: true,
    });
  });

  it("reconnait un hashtag et le distingue d un mot", () => {
    const parsed = parseSearchQuery("#budget budget");
    expect(parsed.hashtags).toEqual(["budget"]);
    expect(parsed.include.map((t) => t.text)).toEqual(["budget"]);
  });

  it("retient les dates valides et ecarte les autres", () => {
    const parsed = parseSearchQuery("on:2026-08-25 before:2026-13-01 after:pas-une-date");
    expect(parsed.on).toBe("2026-08-25");
    expect(parsed.before).toBeUndefined();
    expect(parsed.ignored).toEqual(["before:2026-13-01", "after:pas-une-date"]);
  });

  it("ne prend pour un modificateur que les mots connus", () => {
    const parsed = parseSearchQuery("https://exemple.test/page note:interne");
    expect(parsed.include.map((t) => t.text)).toEqual([
      "https://exemple.test/page",
      "note:interne",
    ]);
    expect(parsed.from).toEqual([]);
  });

  it("tolere un guillemet jamais referme", () => {
    const parsed = parseSearchQuery('budget "note de cadrage');
    expect(parsed.include.map((t) => t.text)).toEqual(["budget", "note de cadrage"]);
  });

  it("ecarte un modificateur sans valeur et le signale", () => {
    const parsed = parseSearchQuery("from: budget");
    expect(parsed.from).toEqual([]);
    expect(parsed.ignored).toEqual(["from:"]);
    expect(parsed.include.map((t) => t.text)).toEqual(["budget"]);
  });

  it("ecarte un terme fait de ponctuation seule", () => {
    const parsed = parseSearchQuery("... budget ???");
    expect(parsed.include.map((t) => t.text)).toEqual(["budget"]);
    expect(parsed.ignored).toEqual(["...", "???"]);
  });

  it("ne renvoie rien d exploitable sur une saisie vide ou blanche", () => {
    expect(parseSearchQuery("   ").include).toEqual([]);
    expect(compile("   ")).toEqual({ kind: "vide" });
  });
});

describe("neutralisation pour FTS5", () => {
  it("met tout terme entre guillemets", () => {
    expect(quoteTerm({ text: "budget", phrase: false, prefix: false })).toBe('"budget"');
  });

  it("laisse l etoile de prefixe hors des guillemets", () => {
    // Entre guillemets, FTS5 traite l etoile comme un caractere ordinaire et la
    // recherche par prefixe cesse de fonctionner.
    expect(quoteTerm({ text: "reuni", phrase: false, prefix: true })).toBe('"reuni"*');
  });

  it("double un guillemet interne", () => {
    expect(quoteTerm({ text: 'il a dit "oui"', phrase: true, prefix: false })).toBe(
      '"il a dit ""oui"""',
    );
  });

  it("rend litteraux les operateurs de FTS5", () => {
    expect(matchOf("AND OR NOT NEAR")).toBe(
      'message:"AND" AND message:"OR" AND message:"NOT" AND message:"NEAR"',
    );
  });

  it("rend litterales les parentheses et les deux points", () => {
    expect(matchOf("(budget) a:b")).toBe('message:"(budget)" AND message:"a:b"');
  });

  it("neutralise une tentative d injection dans l expression", () => {
    // Chaque fragment devient un terme litteral : le guillemet de sortie est
    // double, et tag:c1 est cherche comme du texte au lieu de filtrer sur un
    // canal. Le guillemet final ouvre une phrase vide, qui est ecartee.
    expect(matchOf('budget" OR tag:c1 OR "')).toBe(
      'message:"budget""" AND message:"OR" AND message:"tag:c1" AND message:"OR"',
    );
  });
});

describe("compilation vers une expression MATCH", () => {
  it("joint les termes par AND", () => {
    expect(matchOf("note cadrage")).toBe('message:"note" AND message:"cadrage"');
  });

  it("traduit un canal en terme indexe plutot qu en jointure", () => {
    expect(matchOf("reunion in:general")).toBe('message:"reunion" AND tag:c1');
  });

  it("met les canaux cumules en alternative", () => {
    expect(matchOf("reunion in:general in:tech-archi")).toBe(
      'message:"reunion" AND tag:(c1 OR c2)',
    );
  });

  it("met les auteurs cumules en alternative", () => {
    expect(matchOf("reunion from:alice from:bob")).toBe('message:"reunion" AND tag:(u10 OR u20)');
  });

  it("normalise un hashtag en un terme unique", () => {
    // Le tokenizer coupe sur le tiret : sans normalisation, ce hashtag donnerait
    // trois termes dont deux mots ordinaires du corpus.
    expect(matchOf("#note-de-cadrage")).toBe("tag:hnotedecadrage");
  });

  it("normalise les accents d un hashtag comme le fait le tokenizer", () => {
    expect(matchOf("#café")).toBe("tag:hcafe");
  });

  it("place les exclusions a droite d un NOT binaire", () => {
    // FTS5 n admet pas AND NOT : NOT y est un operateur binaire.
    expect(matchOf("budget -brouillon")).toBe('(message:"budget") NOT (message:"brouillon")');
  });

  it("regroupe plusieurs exclusions en une alternative", () => {
    expect(matchOf("budget -brouillon -from:alice")).toBe(
      '(message:"budget") NOT (message:"brouillon" OR tag:u10)',
    );
  });

  it("refuse une recherche faite uniquement d exclusions", () => {
    expect(compile("-budget")).toEqual({ kind: "sans-terme-positif" });
  });

  it("signale un canal ou un auteur introuvable plutot que d elargir la recherche", () => {
    // Ignorer le filtre rendrait un resultat plus large que demande, que
    // l utilisateur lirait comme la reponse a sa question.
    expect(compile("reunion in:canal-inexistant")).toEqual({
      kind: "introuvable",
      names: ["canal-inexistant"],
    });
    expect(compile("reunion from:carol")).toEqual({ kind: "introuvable", names: ["carol"] });
  });

  it("accepte une fenetre temporelle sans aucun terme", () => {
    const result = compile("on:2026-08-25");
    expect(result).toMatchObject({ kind: "ok", match: "" });
  });
});

describe("bornes temporelles", () => {
  const dayMs = 86_400_000;
  const midnightUtc = Date.UTC(2026, 7, 25);

  it("couvre le jour entier pour on:", () => {
    const range = timeRangeFor(parseSearchQuery("on:2026-08-25"));
    expect(range.fromMs).toBe(midnightUtc);
    expect(range.toMs).toBe(midnightUtc + dayMs - 1);
  });

  it("exclut le jour cite pour after:", () => {
    const range = timeRangeFor(parseSearchQuery("after:2026-08-25"));
    expect(range.fromMs).toBe(midnightUtc + dayMs);
    expect(range.toMs).toBeUndefined();
  });

  it("exclut le jour cite pour before:", () => {
    const range = timeRangeFor(parseSearchQuery("before:2026-08-25"));
    expect(range.toMs).toBe(midnightUtc - 1);
    expect(range.fromMs).toBeUndefined();
  });

  it("intersecte after: et before:", () => {
    const range = timeRangeFor(parseSearchQuery("after:2026-08-01 before:2026-08-25"));
    expect(range.fromMs).toBe(Date.UTC(2026, 7, 2));
    expect(range.toMs).toBe(Date.UTC(2026, 7, 25) - 1);
  });

  it("decale les bornes selon le fuseau du lecteur", () => {
    // A Paris en aout, minuit local vaut 22h00 UTC la veille : sans ce decalage,
    // un message ecrit a 00h30 tomberait la veille.
    const range = timeRangeFor(parseSearchQuery("on:2026-08-25"), 120);
    expect(range.fromMs).toBe(midnightUtc - 120 * 60_000);
    expect(range.toMs).toBe(midnightUtc - 120 * 60_000 + dayMs - 1);
  });
});
