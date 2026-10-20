import { describe, expect, it } from "vitest";
import type { Channel } from "../web/src/client/archive-client.js";
import { parseChannelOrder, sortChannels } from "../web/src/ui/channel-sort.js";

function channel(id: number, displayName: string, posts: number): Channel {
  return {
    id,
    cid: `c${String(id)}`,
    name: displayName.toLowerCase(),
    displayName,
    purpose: "",
    posts,
    firstAt: null,
    lastAt: null,
    archived: false,
  };
}

const byActivity = [
  channel(1, "tech", 40),
  channel(2, "Ecologie", 12),
  channel(3, "accueil", 40),
  channel(4, "canal 10", 3),
  channel(5, "canal 9", 7),
];

const names = (channels: readonly Channel[]): string[] => channels.map((c) => c.displayName);

describe("sortChannels", () => {
  it("garde l ordre d activite livre par l index", () => {
    expect(sortChannels(byActivity, "activite")).toBe(byActivity);
  });

  it("trie par nom sans tenir compte de la casse, chiffres compris", () => {
    expect(names(sortChannels(byActivity, "nom-asc"))).toEqual([
      "accueil",
      "canal 9",
      "canal 10",
      "Ecologie",
      "tech",
    ]);
    expect(names(sortChannels(byActivity, "nom-desc"))).toEqual([
      "tech",
      "Ecologie",
      "canal 10",
      "canal 9",
      "accueil",
    ]);
  });

  it("trie par nombre de messages et departage les egalites par nom", () => {
    expect(names(sortChannels(byActivity, "messages-desc"))).toEqual([
      "accueil",
      "tech",
      "Ecologie",
      "canal 9",
      "canal 10",
    ]);
    expect(names(sortChannels(byActivity, "messages-asc"))).toEqual([
      "canal 10",
      "canal 9",
      "Ecologie",
      "accueil",
      "tech",
    ]);
  });

  it("ne modifie pas la liste recue", () => {
    const before = names(byActivity);
    sortChannels(byActivity, "nom-asc");
    expect(names(byActivity)).toEqual(before);
  });
});

describe("parseChannelOrder", () => {
  it("retombe sur l activite pour une valeur inconnue", () => {
    expect(parseChannelOrder("messages-asc")).toBe("messages-asc");
    expect(parseChannelOrder("n importe quoi")).toBe("activite");
  });
});
