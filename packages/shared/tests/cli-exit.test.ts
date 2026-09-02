import { describe, expect, it } from "vitest";
import { codeDeSortieCommander } from "../src/cli-exit.js";

describe("codeDeSortieCommander", () => {
  it("rend 0 pour une aide ou une version, qui sont des succes", () => {
    // Commander les fait passer par son chemin d erreur alors que l utilisateur
    // a obtenu ce qu il demandait.
    for (const code of ["commander.help", "commander.helpDisplayed", "commander.version"]) {
      expect(codeDeSortieCommander(code), code).toBe(0);
    }
  });

  it("rend 2 pour toute saisie fautive, y compris inconnue", () => {
    for (const code of [
      "commander.unknownOption",
      "commander.missingArgument",
      "commander.optionMissingArgument",
      "commander.invalidArgument",
      "commander.unknownCommand",
      // Un code qu une version ulterieure de commander ajouterait : il vaut
      // mieux le traiter comme une saisie fautive que comme un succes.
      "commander.quelqueChoseDeNouveau",
    ]) {
      expect(codeDeSortieCommander(code), code).toBe(2);
    }
  });

  it("ne rend jamais 1, reserve a ce qui echoue pendant le travail", () => {
    for (const code of ["commander.help", "commander.unknownOption", "autre"]) {
      expect(codeDeSortieCommander(code)).not.toBe(1);
    }
  });
});
