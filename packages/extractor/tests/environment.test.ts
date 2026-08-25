import { describe, expect, it } from "vitest";
import { isCi, isInteractive, missingInputMessage, supportsColor } from "../src/ui/environment.js";

const tty = { isTTY: true } as NodeJS.ReadStream & NodeJS.WriteStream;
const pipe = { isTTY: false } as NodeJS.ReadStream & NodeJS.WriteStream;

describe("isInteractive", () => {
  it("accepte un terminal des deux cotes", () => {
    expect(isInteractive({ stdin: tty, stdout: tty, env: {} })).toBe(true);
  });

  it("refuse quand l entree vient d un tube", () => {
    // Consommer des donnees pipees comme reponse a une invite serait pire que
    // de refuser : la commande avalerait silencieusement le fichier.
    expect(isInteractive({ stdin: pipe, stdout: tty, env: {} })).toBe(false);
  });

  it("refuse quand la sortie est redirigee", () => {
    expect(isInteractive({ stdin: tty, stdout: pipe, env: {} })).toBe(false);
  });

  it("refuse en integration continue, meme avec un terminal", () => {
    // Sinon le processus attend indefiniment une reponse que personne ne donnera.
    expect(isInteractive({ stdin: tty, stdout: tty, env: { CI: "true" } })).toBe(false);
    expect(isInteractive({ stdin: tty, stdout: tty, env: { GITHUB_ACTIONS: "true" } })).toBe(false);
  });

  it("refuse quand --no-input a ete demande", () => {
    expect(isInteractive({ stdin: tty, stdout: tty, env: {}, noInput: true })).toBe(false);
    expect(isInteractive({ stdin: tty, stdout: tty, env: { MMARCHIVE_NO_INPUT: "1" } })).toBe(
      false,
    );
  });
});

describe("isCi", () => {
  it("ignore une variable CI explicitement desactivee", () => {
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
  });

  it("detecte les integrations courantes", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ GITLAB_CI: "yes" })).toBe(true);
    expect(isCi({})).toBe(false);
  });
});

describe("supportsColor", () => {
  it("honore NO_COLOR, meme vide", () => {
    // La convention veut que la seule presence de la variable suffise.
    expect(supportsColor({ stdout: tty, env: { NO_COLOR: "" } })).toBe(false);
  });

  it("colore un terminal sans NO_COLOR", () => {
    expect(supportsColor({ stdout: tty, env: {} })).toBe(true);
  });

  it("ne colore pas une sortie redirigee", () => {
    expect(supportsColor({ stdout: pipe, env: {} })).toBe(false);
  });

  it("laisse FORCE_COLOR passer outre la redirection", () => {
    expect(supportsColor({ stdout: pipe, env: { FORCE_COLOR: "1" } })).toBe(true);
  });
});

describe("missingInputMessage", () => {
  it("nomme le drapeau ET la variable d environnement", () => {
    // Ce message se lit dans un journal d integration continue : il doit
    // suffire a corriger la commande sans consulter la documentation.
    const message = missingInputMessage("Token", "--token", "MM_TOKEN");
    expect(message).toContain("--token");
    expect(message).toContain("MM_TOKEN");
    expect(message).toContain("aucun terminal interactif");
  });
});
