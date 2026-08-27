import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { INDEX_FTS, normalizeHashtag } from "../src/index/schema.js";
import {
  compileSearch,
  parseSearchQuery,
  type SearchResolver,
} from "../src/query/search-syntax.js";

/**
 * Les tests unitaires du parser verifient la chaine produite. Ceux ci verifient
 * que FTS5 l accepte : une expression peut sembler correcte et etre refusee a
 * l execution, ce qui est precisement le piege annonce pour cette partie.
 */
let db: DatabaseSync;

const resolver: SearchResolver = {
  channelIdByName: (name) => ({ general: 1, "tech-archi": 2 })[name],
  userIdByUsername: (name) => ({ alice: 10, bob: 20 })[name],
};

interface Fixture {
  readonly rowid: number;
  readonly message: string;
  readonly channel: number;
  readonly user: number;
  readonly hashtags?: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  { rowid: 1, message: "note de cadrage a relire", channel: 1, user: 10 },
  { rowid: 2, message: "reunion budget reportee", channel: 1, user: 20 },
  { rowid: 3, message: "reunion technique demain", channel: 2, user: 10 },
  { rowid: 4, message: "brouillon de note", channel: 2, user: 20 },
  {
    rowid: 5,
    message: "suivi du sujet",
    channel: 1,
    user: 10,
    hashtags: ["#note-de-cadrage", "#café"],
  },
  { rowid: 6, message: 'il a dit "oui" en reunion', channel: 1, user: 20 },
  { rowid: 7, message: "AND OR NOT sont des mots", channel: 2, user: 10 },
];

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(INDEX_FTS);
  const insert = db.prepare("INSERT INTO search (rowid, message, tag) VALUES (?,?,?)");
  for (const row of FIXTURES) {
    const tags = [
      `c${String(row.channel)}`,
      `u${String(row.user)}`,
      ...(row.hashtags ?? []).map((tag) => normalizeHashtag(tag)),
    ].join(" ");
    insert.run(row.rowid, row.message, tags);
  }
});

function search(input: string): number[] {
  const outcome = compileSearch(parseSearchQuery(input), resolver);
  if (outcome.kind !== "ok") throw new Error(`compilation ${outcome.kind}`);
  if (outcome.match === "") return [];
  const rows = db
    .prepare("SELECT rowid FROM search WHERE search MATCH ? ORDER BY rowid")
    .all(outcome.match);
  return rows.map((row) => Number(row.rowid));
}

describe("expressions acceptees et justes", () => {
  it("trouve un mot", () => {
    expect(search("reunion")).toEqual([2, 3, 6]);
  });

  it("exige tous les mots d une conjonction", () => {
    expect(search("reunion budget")).toEqual([2]);
  });

  it("distingue la phrase exacte de la conjonction", () => {
    expect(search('"note de cadrage"')).toEqual([1]);
    expect(search("note cadrage")).toEqual([1]);
    // Les deux mots existent dans le message 1, mais pas dans cet ordre.
    expect(search('"cadrage note"')).toEqual([]);
    expect(search('"de note"')).toEqual([4]);
  });

  it("applique l exclusion", () => {
    expect(search("reunion -budget")).toEqual([3, 6]);
  });

  it("restreint a un canal", () => {
    expect(search("reunion in:general")).toEqual([2, 6]);
  });

  it("restreint a plusieurs canaux", () => {
    expect(search("reunion in:general in:tech-archi")).toEqual([2, 3, 6]);
  });

  it("restreint a un auteur", () => {
    expect(search("reunion from:bob")).toEqual([2, 6]);
  });

  it("cumule canal et auteur", () => {
    expect(search("reunion in:general from:bob")).toEqual([2, 6]);
  });

  it("exclut un auteur", () => {
    expect(search("reunion -from:bob")).toEqual([3]);
  });

  it("trouve par prefixe", () => {
    expect(search("reuni*")).toEqual([2, 3, 6]);
    expect(search("reuni")).toEqual([]);
  });

  it("trouve un hashtag a tirets sans le confondre avec ses mots", () => {
    expect(search("#note-de-cadrage")).toEqual([5]);
    // Le mot "cadrage" du message 1 ne doit pas repondre au hashtag.
    expect(search("#cadrage")).toEqual([]);
  });

  it("trouve un hashtag accentue", () => {
    expect(search("#café")).toEqual([5]);
    expect(search("#cafe")).toEqual([5]);
  });

  it("traite les operateurs de FTS5 comme des mots ordinaires", () => {
    expect(search("AND")).toEqual([7]);
    expect(search("NOT OR")).toEqual([7]);
  });

  it("cherche un guillemet present dans le texte", () => {
    expect(search('"il a dit ""oui"""')).toEqual([6]);
  });

  it("ignore les accents de la requete", () => {
    expect(search("réunion")).toEqual([2, 3, 6]);
  });
});

describe("saisies hostiles", () => {
  const hostiles = [
    'budget" OR tag:c1 OR "',
    "budget (",
    "budget )",
    'budget "',
    "budget *",
    "*",
    "-",
    "budget NEAR(a b)",
    "budget^2",
    "in:general )",
    "budget: ((( ",
    '""""',
    "a AND OR NOT NEAR b",
    "#-",
    "budget\\",
    "'; DROP TABLE search; --",
  ];

  it("ne produit jamais d expression refusee par FTS5", () => {
    for (const input of hostiles) {
      const outcome = compileSearch(parseSearchQuery(input), resolver);
      if (outcome.kind !== "ok" || outcome.match === "") continue;
      expect(
        () => db.prepare("SELECT rowid FROM search WHERE search MATCH ?").all(outcome.match),
        `saisie refusee : ${input} -> ${outcome.match}`,
      ).not.toThrow();
    }
  });

  it("laisse la table intacte apres une saisie qui ressemble a du SQL", () => {
    search("'; DROP TABLE search; --");
    const count = db.prepare("SELECT count(*) c FROM search").get();
    expect(Number(count?.c)).toBe(FIXTURES.length);
  });
});
