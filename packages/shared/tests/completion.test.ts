import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_SHELLS,
  type DescribableCommand,
  describeProgram,
  generateCompletion,
  isCompletionShell,
} from "../src/completion.js";

function commande(
  nom: string,
  description: string,
  options: readonly string[],
  sous: readonly DescribableCommand[] = [],
): DescribableCommand {
  return {
    name: () => nom,
    description: () => description,
    options: options.map((long) => ({ long })),
    commands: sous,
  };
}

const PROGRAMME = commande(
  "outil-test",
  "",
  ["--verbose"],
  [
    commande("inventory", "Inventorie les canaux", ["--url", "--out"]),
    commande("run", "Extrait, apres confirmation", ["--file", "--yes"]),
  ],
);

describe("describeProgram", () => {
  it("derive les sous-commandes du programme au lieu de les lister", () => {
    const spec = describeProgram(PROGRAMME);
    expect(spec.binary).toBe("outil-test");
    expect(spec.subcommands.map((s) => s.name)).toEqual(["inventory", "run"]);
    expect(spec.subcommands[1]?.options).toEqual(["--file", "--yes"]);
  });

  it("ajoute l aide, que commander garde hors de ses options", () => {
    // Sans cela, la seule option que toutes les commandes acceptent serait la
    // seule que la completion ne proposerait pas.
    expect(describeProgram(PROGRAMME).globalOptions).toContain("--help");
    expect(describeProgram(PROGRAMME).globalOptions).toContain("-h");
  });
});

describe("generateCompletion", () => {
  it("emet un script pour chacun des trois shells", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = generateCompletion(describeProgram(PROGRAMME), shell);
      expect(script, shell).toContain("outil-test");
      expect(script, shell).toContain("inventory");
      // Fish nomme les options sans leurs tirets, les deux autres avec.
      expect(script, shell).toContain(shell === "fish" ? "-l 'yes'" : "--yes");
    }
  });

  it("declare une option courte comme courte chez fish", () => {
    // `-l 'h'` declarerait une option longue « --h » que le binaire ne connait
    // pas, et la completion proposerait un drapeau inexistant.
    const script = generateCompletion(describeProgram(PROGRAMME), "fish");
    expect(script).toContain("-s 'h'");
    expect(script).not.toContain("-l 'h'");
  });

  it("echappe les apostrophes d une description, qui casseraient le script", () => {
    const avecApostrophe = commande("prog", "", [], [commande("run", "Ce qu'il fait", [])]);
    for (const shell of ["zsh", "fish"] as const) {
      const script = generateCompletion(describeProgram(avecApostrophe), shell);
      expect(script, shell).toContain("Ce qu'\\''il fait");
    }
  });

  it("ne laisse aucun tiret dans le nom de la fonction shell", () => {
    // « _mmarchive-extract » n est pas un identifiant de fonction valide.
    const script = generateCompletion(
      describeProgram(commande("mmarchive-extract", "", [])),
      "bash",
    );
    expect(script).toContain("_mmarchive_extract()");
    expect(script).not.toContain("_mmarchive-extract()");
  });
});

/**
 * Complete pour de vrai, en sourcant le script dans bash.
 *
 * Le seul moyen de savoir qu une completion complete. Une assertion sur le texte
 * du script dirait qu il contient les bons mots, pas qu il propose les bonnes
 * valeurs au bon moment.
 */
function completerAvecBash(script: string, ligne: string, curseur: number): string[] {
  const programme = [
    script,
    `COMP_WORDS=(${ligne})`,
    `COMP_CWORD=${String(curseur)}`,
    "_outil_test",
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join("\n");
  return execFileSync("bash", ["-c", programme], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");
}

describe("le script bash complete vraiment", () => {
  const script = generateCompletion(describeProgram(PROGRAMME), "bash");

  it("propose les sous-commandes au premier mot", () => {
    expect(completerAvecBash(script, "outil-test inv", 1)).toEqual(["inventory"]);
  });

  it("propose les options de la sous-commande une fois celle-ci saisie", () => {
    expect(completerAvecBash(script, "outil-test run --y", 2)).toEqual(["--yes"]);
  });

  it("trouve la sous-commande meme precedee d une option globale", () => {
    // Commander accepte « prog --verbose inventory » : supposer la sous-commande
    // au mot 1 faisait alors proposer les options globales a sa place.
    expect(completerAvecBash(script, "outil-test --verbose inventory --o", 3)).toEqual(["--out"]);
  });

  it("propose encore les sous-commandes quand seule une option a ete saisie", () => {
    expect(completerAvecBash(script, "outil-test --verbose ru", 2)).toEqual(["run"]);
  });
});

describe("isCompletionShell", () => {
  it("accepte les trois shells connus et rien d autre", () => {
    for (const shell of COMPLETION_SHELLS) expect(isCompletionShell(shell)).toBe(true);
    for (const autre of ["powershell", "sh", "", "BASH"]) {
      expect(isCompletionShell(autre), autre).toBe(false);
    }
  });
});
