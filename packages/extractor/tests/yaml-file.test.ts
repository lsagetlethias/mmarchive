import { type SelectionFile, summarizeSelection } from "@mmarchive/shared";
import { describe, expect, it } from "vitest";
import {
  parseSelectionFile,
  renderSelectionFile,
  SelectionFileError,
} from "../src/inventory/yaml-file.js";

function sampleFile(): SelectionFile {
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
        joined: true,
        channels: [
          {
            id: "a".repeat(26),
            name: "town-square",
            display_name: "Town Square",
            type: "O",
            joined: true,
            archived: false,
            message_count: 12043,
            last_post_at: "2026-08-20T14:22:00.000Z",
            selected: true,
          },
          {
            id: "b".repeat(26),
            name: "tech-archi",
            display_name: "Tech et Archi",
            type: "O",
            joined: false,
            archived: false,
            message_count: 8721,
            selected: true,
          },
          {
            id: "c".repeat(26),
            name: "vieux-projet",
            display_name: "Vieux Projet",
            type: "O",
            joined: false,
            archived: true,
            readable: false,
            message_count: 430,
            selected: false,
          },
        ],
      },
    ],
  };
}

describe("renderSelectionFile", () => {
  it("fait un aller-retour sans perte", () => {
    const file = sampleFile();
    const parsed = parseSelectionFile(renderSelectionFile(file), "channels.yaml");
    expect(parsed).toEqual(file);
  });

  it("annonce le nombre exact de joins induits dans l en-tete", () => {
    const file = sampleFile();
    const text = renderSelectionFile(file);
    expect(text).toContain("1 join");
    expect(text).toContain("ATTENTION");
    expect(text).toContain("- tech-archi");
  });

  it("n annonce aucune alerte quand la selection ne coute rien", () => {
    const file = sampleFile();
    const second = file.teams[0]?.channels[1];
    if (second) Object.assign(second, { selected: false });
    const text = renderSelectionFile(file);
    expect(text).toContain("0 join");
    expect(text).not.toContain("ATTENTION");
  });

  it("marque visuellement les canaux qui declencheront un join", () => {
    const text = renderSelectionFile(sampleFile());
    expect(text).toMatch(/joined: false\s+#\s+JOIN REQUIS/);
  });

  it("signale les canaux archives illisibles", () => {
    const text = renderSelectionFile(sampleFile());
    expect(text).toMatch(/archived: true\s+#\s+archive et ILLISIBLE/);
  });

  it("signale les canaux dont on est deja membre comme sans effet de bord", () => {
    const text = renderSelectionFile(sampleFile());
    expect(text).toMatch(/joined: true\s+#\s+deja membre/);
  });

  it("compte les canaux illisibles selectionnes dans l en-tete", () => {
    const file = sampleFile();
    const third = file.teams[0]?.channels[2];
    if (third) Object.assign(third, { selected: true });
    const text = renderSelectionFile(file, summarizeSelection(file));
    expect(text).toContain("illisibles et seront ignores");
  });
});

describe("parseSelectionFile", () => {
  it("refuse un YAML syntaxiquement invalide", () => {
    expect(() => parseSelectionFile("teams: [oups", "x.yaml")).toThrow(SelectionFileError);
  });

  it("refuse un fichier sans bloc meta", () => {
    expect(() => parseSelectionFile("teams: []", "x.yaml")).toThrow(SelectionFileError);
  });

  it.each(["P", "D", "G"])("refuse un canal de type %s ajoute a la main dans le YAML", (type) => {
    // Verification defensive : le fichier de selection est editable a la main,
    // c est le chemin le plus plausible pour faire entrer un canal prive dans
    // une archive. Le schema doit le rendre impossible.
    const file = sampleFile();
    const channel = file.teams[0]?.channels[0];
    if (channel) Object.assign(channel, { type });
    const text = renderSelectionFile(sampleFile()).replace("type: O", `type: ${type}`);
    expect(() => parseSelectionFile(text, "x.yaml")).toThrow(SelectionFileError);
  });

  it("mentionne la commande de regeneration dans le message d erreur", () => {
    try {
      parseSelectionFile("teams: []", "x.yaml");
      expect.unreachable("aurait du lever");
    } catch (error) {
      expect((error as Error).message).toContain("mmarchive-extract inventory");
    }
  });
});
