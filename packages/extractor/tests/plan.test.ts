import { describe, expect, it } from "vitest";
import {
  NonPublicChannelError,
  type SelectionChannel,
  type SelectionFile,
} from "@mmarchive/shared";
import {
  SelectionMismatchError,
  assertSelectionMatchesTarget,
  buildPlan,
  restrictToAccessible,
} from "../src/extract/plan.js";

function channel(over: Partial<SelectionChannel> = {}): SelectionChannel {
  return {
    id: "c".repeat(26),
    name: "canal",
    display_name: "Canal",
    type: "O",
    joined: false,
    archived: false,
    message_count: 0,
    selected: false,
    ...over,
  };
}

function file(channels: SelectionChannel[], teamJoined = true): SelectionFile {
  return {
    meta: {
      generated_at: "2026-08-24T10:00:00.000Z",
      tool_version: "0.1.0",
      source_url: "https://mm.example.org",
      account: { user_id: "u".repeat(26), username: "alice", is_system_admin: false },
    },
    teams: [
      {
        id: "t".repeat(26),
        name: "produit",
        display_name: "Produit",
        joined: teamJoined,
        channels,
      },
    ],
  };
}

describe("buildPlan", () => {
  it("n inscrit aucun join pour un canal non selectionne", () => {
    // Verification defensive numero 2 : aucun join ne doit etre emis pour un
    // canal absent de la selection.
    const plan = buildPlan(
      file([
        channel({ id: "a".repeat(26), joined: false, selected: false }),
        channel({ id: "b".repeat(26), joined: false, selected: false }),
      ]),
    );
    expect(plan.joins).toEqual([]);
    expect(plan.channels).toEqual([]);
  });

  it("n inscrit un join que pour les canaux selectionnes et non rejoints", () => {
    const plan = buildPlan(
      file([
        channel({ id: "a".repeat(26), joined: true, selected: true }),
        channel({ id: "b".repeat(26), joined: false, selected: true }),
        channel({ id: "d".repeat(26), joined: false, selected: false }),
      ]),
    );
    expect(plan.channels).toHaveLength(2);
    expect(plan.joins.map((j) => j.channel.id)).toEqual(["b".repeat(26)]);
  });

  it("n inscrit jamais un canal archive dans les joins", () => {
    const plan = buildPlan(
      file([channel({ joined: false, archived: true, readable: true, selected: true })]),
    );
    expect(plan.joins).toEqual([]);
    expect(plan.channels).toHaveLength(1);
  });

  it("ecarte les canaux archives illisibles au lieu de les extraire", () => {
    const plan = buildPlan(
      file([channel({ joined: false, archived: true, readable: false, selected: true })]),
    );
    expect(plan.channels).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toBe("archived_unreadable");
  });

  it("n inscrit pas de join pour un canal lisible sans etre membre", () => {
    const plan = buildPlan(
      file([channel({ joined: false, archived: false, readable: true, selected: true })]),
    );
    expect(plan.joins).toEqual([]);
    expect(plan.channels).toHaveLength(1);
  });

  it("signale la team a rejoindre quand elle n est pas deja rejointe", () => {
    const plan = buildPlan(file([channel({ joined: false, selected: true })], false));
    expect(plan.teamsToJoin).toEqual(["t".repeat(26)]);
  });

  it.each(["P", "D", "G"])("refuse un canal de type %s injecte dans le YAML", (type) => {
    // Verification defensive numero 1 : meme edite a la main, un canal non
    // public ne doit pas pouvoir atteindre l extraction.
    const bad = { ...channel({ selected: true }), type } as unknown as SelectionChannel;
    expect(() => buildPlan(file([bad]))).toThrow(NonPublicChannelError);
  });
});

describe("restrictToAccessible", () => {
  it("ne selectionne que ce qui ne coute aucun join", () => {
    const restricted = restrictToAccessible(
      file([
        channel({ id: "a".repeat(26), joined: true, selected: false }),
        channel({ id: "b".repeat(26), joined: false, selected: true }),
        channel({ id: "d".repeat(26), joined: false, readable: true, selected: false }),
        channel({
          id: "e".repeat(26),
          joined: false,
          archived: true,
          readable: true,
          selected: true,
        }),
      ]),
    );
    const plan = buildPlan(restricted);
    expect(plan.joins).toEqual([]);
    expect(plan.channels.map((c) => c.channel.id).sort()).toEqual(
      ["a".repeat(26), "d".repeat(26)].sort(),
    );
  });

  it("produit un plan sans aucun join meme si tout etait coche", () => {
    const everything = file([
      channel({ id: "a".repeat(26), joined: false, selected: true }),
      channel({ id: "b".repeat(26), joined: false, selected: true }),
    ]);
    const plan = buildPlan(restrictToAccessible(everything));
    expect(plan.joins).toEqual([]);
    expect(plan.channels).toEqual([]);
  });
});

describe("assertSelectionMatchesTarget", () => {
  it("accepte la meme instance a un slash final pres", () => {
    expect(() => {
      assertSelectionMatchesTarget(file([]), "https://mm.example.org/");
    }).not.toThrow();
  });

  it("refuse une instance differente", () => {
    expect(() => {
      assertSelectionMatchesTarget(file([]), "https://autre.example.org");
    }).toThrow(SelectionMismatchError);
  });

  it("explique comment regenerer le fichier", () => {
    try {
      assertSelectionMatchesTarget(file([]), "https://autre.example.org");
      expect.unreachable("aurait du lever");
    } catch (error) {
      expect((error as Error).message).toContain("mmarchive-extract inventory");
    }
  });
});
