import { describe, expect, it } from "vitest";
import { BUG_REPORT_URL, describeFailure, ERROR_CODES } from "../src/index.js";

function erreur(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("describeFailure", () => {
  it("porte la version, qu une capture d ecran rendra lisible des mois plus tard", () => {
    const rendu = describeFailure(erreur(ERROR_CODES.OptionsError, "chemin absent"), "1.2.3");
    expect(rendu).toContain("[E1001] chemin absent");
    expect(rendu).toContain("mmarchive 1.2.3");
  });

  it("invite a signaler quand le code designe une panne de l outil", () => {
    for (const code of [
      ERROR_CODES.ForbiddenMutationError,
      ERROR_CODES.ConsentViolationError,
      ERROR_CODES.NonPublicChannelError,
      ERROR_CODES.NdjsonSerializeError,
      ERROR_CODES.ResidualIdentityError,
    ]) {
      expect(describeFailure(erreur(code, "panne"), "1.2.3"), code).toContain(BUG_REPORT_URL);
    }
  });

  it("n invite pas a signaler une saisie que l utilisateur corrige lui-meme", () => {
    // Inviter a ouvrir un ticket pour un chemin mal tape ferait du bruit et
    // apprendrait a ignorer l invitation quand elle compte.
    for (const code of [
      ERROR_CODES.OptionsError,
      ERROR_CODES.SelectionFileError,
      ERROR_CODES.MattermostAuthError,
      ERROR_CODES.NdjsonReadError,
      ERROR_CODES.IndexReadError,
    ]) {
      expect(describeFailure(erreur(code, "saisie"), "1.2.3"), code).not.toContain(BUG_REPORT_URL);
    }
  });

  it("reste lisible pour ce qui n est pas une erreur du registre", () => {
    expect(describeFailure(new Error("panne brute"), "1.2.3")).toContain("panne brute");
    expect(describeFailure("juste une chaine", "1.2.3")).toContain("juste une chaine");
  });
});
