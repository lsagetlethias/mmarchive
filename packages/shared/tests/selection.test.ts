import { describe, expect, it } from "vitest";
import {
  categorizeChannel,
  defaultSelected,
  isExtractable,
  requiresJoin,
  summarizeSelection,
  type SelectionChannel,
  type SelectionTeam,
} from "../src/selection.js";

function channel(overrides: Partial<SelectionChannel> = {}): SelectionChannel {
  return {
    id: "c".repeat(26),
    name: "un-canal",
    display_name: "Un canal",
    type: "O",
    joined: false,
    archived: false,
    message_count: 0,
    selected: false,
    ...overrides,
  };
}

function team(overrides: Partial<SelectionTeam> = {}): SelectionTeam {
  return {
    id: "t".repeat(26),
    name: "une-team",
    display_name: "Une team",
    joined: true,
    channels: [],
    ...overrides,
  };
}

describe("categorizeChannel", () => {
  it("classe un canal deja rejoint en member", () => {
    expect(categorizeChannel({ joined: true, archived: false })).toBe("member");
  });

  it("classe un canal non rejoint et non sonde en join_required", () => {
    expect(categorizeChannel({ joined: false, archived: false })).toBe("join_required");
  });

  it("classe un canal non rejoint mais lisible en readable_without_join", () => {
    expect(categorizeChannel({ joined: false, archived: false, readable: true })).toBe(
      "readable_without_join",
    );
  });

  it("classe un canal archive et lisible en archived_readable", () => {
    expect(categorizeChannel({ joined: false, archived: true, readable: true })).toBe(
      "archived_readable",
    );
  });

  it("classe un canal archive dont on est membre en archived_readable", () => {
    expect(categorizeChannel({ joined: true, archived: true })).toBe("archived_readable");
  });

  it("classe un canal archive illisible en archived_unreadable", () => {
    expect(categorizeChannel({ joined: false, archived: true, readable: false })).toBe(
      "archived_unreadable",
    );
  });

  it("classe un canal archive non sonde en archived_unreadable", () => {
    expect(categorizeChannel({ joined: false, archived: true })).toBe("archived_unreadable");
  });
});

describe("requiresJoin", () => {
  it("n exige un join que pour un canal actif non rejoint et non lisible", () => {
    expect(requiresJoin({ joined: false, archived: false })).toBe(true);
  });

  it("n exige jamais de join pour un canal deja rejoint", () => {
    expect(requiresJoin({ joined: true, archived: false })).toBe(false);
  });

  it("n exige jamais de join pour un canal archive, meme illisible", () => {
    // Un canal archive n est pas joignable cote Mattermost : proposer un join
    // serait a la fois inutile et trompeur.
    expect(requiresJoin({ joined: false, archived: true, readable: false })).toBe(false);
    expect(requiresJoin({ joined: false, archived: true, readable: true })).toBe(false);
  });

  it("n exige pas de join quand le canal est deja lisible sans etre membre", () => {
    expect(requiresJoin({ joined: false, archived: false, readable: true })).toBe(false);
  });
});

describe("isExtractable", () => {
  it("exclut uniquement les canaux archives illisibles", () => {
    expect(isExtractable({ joined: false, archived: true, readable: false })).toBe(false);
    expect(isExtractable({ joined: false, archived: false })).toBe(true);
    expect(isExtractable({ joined: true, archived: false })).toBe(true);
    expect(isExtractable({ joined: false, archived: true, readable: true })).toBe(true);
  });
});

describe("defaultSelected", () => {
  it("selectionne par defaut ce qui est gratuit", () => {
    expect(defaultSelected({ joined: true, archived: false })).toBe(true);
    expect(defaultSelected({ joined: false, archived: false, readable: true })).toBe(true);
  });

  it("ne selectionne JAMAIS par defaut un canal qui demanderait un join", () => {
    expect(defaultSelected({ joined: false, archived: false })).toBe(false);
    expect(defaultSelected({ joined: false, archived: false, readable: false })).toBe(false);
  });

  it("pre-coche un canal archive lisible quand la politique le demande", () => {
    // Sur une instance en fin de vie, ces canaux disparaissent definitivement.
    // Les inclure reste un choix explicite, jamais un defaut.
    expect(
      defaultSelected(
        { joined: false, archived: true, readable: true },
        { includeArchivedReadable: true },
      ),
    ).toBe(true);
  });

  it("ne pre-coche jamais un canal archive ILLISIBLE, meme avec la politique", () => {
    expect(
      defaultSelected(
        { joined: false, archived: true, readable: false },
        { includeArchivedReadable: true },
      ),
    ).toBe(false);
  });

  it("la politique des archives ne change rien pour un canal exigeant un join", () => {
    // Garde-fou : aucune option ne doit pouvoir pre-cocher un canal dont
    // l extraction publierait un message systeme.
    expect(
      defaultSelected({ joined: false, archived: false }, { includeArchivedReadable: true }),
    ).toBe(false);
  });

  it("ne selectionne pas par defaut un canal archive", () => {
    // Meme lisible : l utilisateur doit decider explicitement d embarquer
    // l historique d un canal mort.
    expect(defaultSelected({ joined: false, archived: true, readable: true })).toBe(false);
    expect(defaultSelected({ joined: false, archived: true, readable: false })).toBe(false);
  });
});

describe("summarizeSelection", () => {
  it("ne compte aucun join quand rien n est selectionne", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          channels: [
            channel({ id: "a".repeat(26), joined: false, selected: false }),
            channel({ id: "b".repeat(26), joined: false, selected: false }),
          ],
        }),
      ],
    });
    expect(summary.joinsInduced).toBe(0);
    expect(summary.channelsRequiringJoin).toEqual([]);
    expect(summary.channelsSelected).toBe(0);
  });

  it("ne compte que les canaux non rejoints ET selectionnes", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          channels: [
            channel({ id: "a".repeat(26), joined: true, selected: true, message_count: 10 }),
            channel({ id: "b".repeat(26), joined: false, selected: true, message_count: 20 }),
            channel({ id: "c".repeat(26), joined: false, selected: false, message_count: 40 }),
          ],
        }),
      ],
    });
    expect(summary.joinsInduced).toBe(1);
    expect(summary.channelsRequiringJoin.map((c) => c.id)).toEqual(["b".repeat(26)]);
    expect(summary.channelsSelected).toBe(2);
    expect(summary.estimatedMessages).toBe(30);
  });

  it("n induit pas de join pour un canal archive selectionne", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          channels: [channel({ joined: false, archived: true, readable: true, selected: true })],
        }),
      ],
    });
    expect(summary.joinsInduced).toBe(0);
    expect(summary.channelsArchived).toBe(1);
  });

  it("compte les canaux selectionnes mais illisibles a part", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          channels: [channel({ joined: false, archived: true, readable: false, selected: true })],
        }),
      ],
    });
    expect(summary.unreadableSelected).toBe(1);
    expect(summary.joinsInduced).toBe(0);
  });

  it("signale les teams non rejointes qui contiennent une selection", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          id: "t1".padEnd(26, "x"),
          joined: false,
          channels: [channel({ joined: false, selected: true })],
        }),
        team({
          id: "t2".padEnd(26, "x"),
          joined: true,
          channels: [channel({ joined: false, selected: true })],
        }),
      ],
    });
    expect(summary.teamsRequiringJoin).toEqual(["t1".padEnd(26, "x")]);
  });

  it("agrege les compteurs sur plusieurs teams", () => {
    const summary = summarizeSelection({
      teams: [
        team({
          id: "t1".padEnd(26, "x"),
          channels: [
            channel({ id: "a".repeat(26), joined: true, selected: true, message_count: 100 }),
            channel({ id: "b".repeat(26), joined: false, selected: true, message_count: 200 }),
          ],
        }),
        team({
          id: "t2".padEnd(26, "x"),
          channels: [
            channel({ id: "c".repeat(26), joined: true, selected: true, message_count: 5 }),
            channel({ id: "d".repeat(26), joined: false, archived: true, selected: false }),
          ],
        }),
      ],
    });
    expect(summary.channelsTotal).toBe(4);
    expect(summary.channelsSelected).toBe(3);
    expect(summary.channelsAlreadyMember).toBe(2);
    expect(summary.channelsArchived).toBe(1);
    expect(summary.joinsInduced).toBe(1);
    expect(summary.estimatedMessages).toBe(305);
  });
});
