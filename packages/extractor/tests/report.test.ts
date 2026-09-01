import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnonymizeResult } from "../src/redact/anonymize-archive.js";
import { AnonymizeError, refuserCheminInterne } from "../src/redact/anonymize-archive.js";
import {
  compteursReferencesVides,
  effectifPublic,
  mesuresVides,
  partPublique,
} from "../src/redact/report-data.js";
import { type ContexteRapport, rendreReleve, rendreSynthese } from "../src/redact/report-render.js";
import type { ResidualReport } from "../src/redact/residual-check.js";
import { compteursTexteVides } from "../src/redact/text-rewrite.js";

/** Chaines d origine qui ne doivent jamais atteindre la synthese. */
const SECRETS = ["alice.martin", "Alice", "canal-de-bob", "bob@exemple.org", "ppppp".repeat(5)];

function contexte(over: {
  manquements?: ResidualReport["manquements"];
  mesures?: Partial<ReturnType<typeof mesuresVides>>;
}): ContexteRapport {
  const resultat: AnonymizeResult = {
    comptes: 3,
    posts: 10,
    canaux: 1,
    emojis: 0,
    fichiers: 0,
    reactions: 0,
    references: compteursReferencesVides(),
    props: {
      clesRetirees: 0,
      referencesReecrites: 0,
      referencesOrphelines: 0,
      attachmentsReduits: 0,
    },
    nomsSubstitues: 0,
    nomsNonTrouves: 0,
    texteCorps: compteursTexteVides(),
    texteBlocs: compteursTexteVides(),
    binairesNonRepris: 0,
    niveau: "noms",
    vocabulaire: undefined,
  };
  return {
    resultat,
    controle: {
      referencesVerifiees: 10,
      valeursVerifiees: 5,
      manquements: over.manquements ?? [],
      horsControle: ["le corps des messages"],
      mesures: { ...mesuresVides(), messages: 10, ...over.mesures },
    },
    versionOutil: "1.2.3",
    horodatage: "2026-08-31T12:00:00.000Z",
    releveProduit: false,
  };
}

describe("la synthese", () => {
  it("ne porte aucune chaine d origine, quelle que soit la matiere qu on lui donne", () => {
    // C est l invariant central : la synthese est le document qui circule, et
    // 1 344 des formes non resolues de l archive de reference ne sont vues
    // qu une fois, donc chaque forme listee designerait quelqu un.
    const texte = rendreSynthese(
      contexte({
        manquements: [
          {
            emplacement: "users.ndjson",
            champ: "first_name",
            genre: "identite-survivante",
            extrait: "alice.martin",
          },
        ],
        mesures: {
          formesNonResolues: [
            { forme: "Alice", occurrences: 3, canaux: 1, connueDeLAnnuaire: true },
          ],
          canauxCandidats: [
            {
              nom: "canal-de-bob",
              nomAffiche: "canal-de-bob",
              jeton: "bob",
              champ: "name",
              porteurs: 1,
            },
          ],
          canauxDistincts: 1,
          identifiantsColles: [{ postId: "p".repeat(26), canal: "c".repeat(26), occurrences: 1 }],
        },
      }),
    );
    for (const secret of SECRETS) {
      expect(texte, `la synthese porte ${secret}`).not.toContain(secret);
    }
    // Ni identifiant d emplacement : ils sont recopies a l identique dans
    // l archive diffusee, donc ce serait une cle de jointure exacte.
    expect(texte).not.toContain("p".repeat(26));
    expect(texte).not.toContain("c".repeat(26));
  });

  it("dit d abord qu elle ne se diffuse pas", () => {
    const texte = rendreSynthese(contexte({}));
    const entete = texte.slice(0, 300);
    expect(entete).toContain("ne se diffuse pas");
  });

  it("ne rend jamais de verdict positif", () => {
    const texte = rendreSynthese(contexte({}));
    expect(texte).toContain("sans_avis");
    expect(texte).not.toContain("diffusable**");
    expect(texte.toLowerCase()).not.toContain("conforme");
  });

  it("rend un verdict negatif quand une identite a survecu", () => {
    const texte = rendreSynthese(
      contexte({
        manquements: [
          { emplacement: "users.ndjson", champ: "id", genre: "reference-inconnue", extrait: "x" },
        ],
      }),
    );
    expect(texte).toContain("non_diffusable");
  });

  it("rend un verdict negatif quand un nom survit la ou la passe substitue", () => {
    // Le controle residuel ne peut pas le voir : il range le corps des messages
    // dans ce qu il ne couvre pas. Le rapport le calcule.
    const texte = rendreSynthese(contexte({ mesures: { nomsResiduelsSysteme: 12 } }));
    expect(texte).toContain("non_diffusable");
    expect(texte).toContain("12");
  });

  it("ne pretend pas etablir une relation qu il ne peut pas prouver", () => {
    // Le producteur n a pas la table des identites, a dessein : il compte une
    // presence, pas un appariement, et doit le dire.
    const texte = rendreSynthese(contexte({ mesures: { nomsResiduelsSysteme: 3 } }));
    expect(texte).toContain("ne dit pas");
    expect(texte).toContain("table des identites");
  });
});

describe("le seuil d effectif", () => {
  it("fond toute classe de moins de cinq", () => {
    // Un decompte a un n est pas un decompte, c est une designation.
    expect(effectifPublic(1)).toBe("moins de 5");
    expect(effectifPublic(4)).toBe("moins de 5");
    expect(effectifPublic(5)).toBe("5");
    expect(effectifPublic(0)).toBe("0");
  });

  it("ne restitue pas par un pourcentage un effectif qu il vient de supprimer", () => {
    expect(partPublique(1, 3277)).toBe("moins de 0,2 %");
    expect(partPublique(0, 3277)).toBe("0,0 %");
  });

  it("calcule la borne sur le denominateur au lieu de l ecrire en dur", () => {
    // Une borne figee serait fausse des qu on change de taille d archive, et le
    // rapport deviendrait faux la ou il se veut prudent.
    expect(partPublique(1, 10)).toBe("moins de 50,0 %");
    expect(partPublique(1, 100)).toBe("moins de 5,0 %");
  });

  it("s arrete a une decimale, le denominateur etant public", () => {
    // Un taux a trois decimales sur 3 277 comptes est un numerateur deguise.
    expect(partPublique(1234, 3277)).toBe("37,7 %");
  });
});

describe("le releve", () => {
  it("s ouvre sur ce qu il est et sur l ordre de le detruire", () => {
    const premiere = rendreReleve(contexte({})).split("\n")[0] ?? "";
    const entete = JSON.parse(premiere) as Record<string, unknown>;
    expect(String(entete["_"])).toContain("NE PAS DIFFUSER");
    expect(String(entete["_"])).toContain("detruire");
  });

  it("place les canaux avant tout le reste", () => {
    // C est la seule rubrique sur laquelle un operateur agit AVANT de diffuser.
    const lignes = rendreReleve(
      contexte({
        manquements: [{ emplacement: "x", champ: "y", genre: "reference-inconnue", extrait: "z" }],
        mesures: {
          canauxCandidats: [{ nom: "n", nomAffiche: "n", jeton: "j", champ: "name", porteurs: 1 }],
        },
      }),
    )
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lignes[1]?.["rubrique"]).toBe("canal_candidat");
    expect(lignes[2]?.["rubrique"]).toBe("manquement");
  });
});

describe("l emplacement des documents", () => {
  let racine: string;

  beforeEach(async () => {
    racine = await mkdtemp(join(tmpdir(), "mmarchive-rapport-"));
  });

  afterEach(async () => {
    await rm(racine, { recursive: true, force: true });
  });

  it("refuse d ecrire dans l archive produite, qui serait diffusee avec", async () => {
    const sortie = join(racine, "sortie");
    await expect(
      refuserCheminInterne(join(sortie, "rapport.md"), join(racine, "src"), sortie),
    ).rejects.toThrow(AnonymizeError);
  });

  it("refuse d ecrire dans l archive source", async () => {
    const source = join(racine, "src");
    await expect(
      refuserCheminInterne(join(source, "sous", "rapport.md"), source, join(racine, "sortie")),
    ).rejects.toThrow(/a l interieur de l archive source/);
  });

  it("refuse un chemin qui atteint la sortie par un lien symbolique", async () => {
    // `resolve` ne fait que du calcul de chaine : un lien pose en dehors et
    // pointant vers la sortie passait le controle, et l ecriture suivait le lien.
    const sortie = join(racine, "sortie");
    await mkdir(sortie, { recursive: true });
    const passerelle = join(racine, "passerelle");
    await symlink(sortie, passerelle);
    await expect(
      refuserCheminInterne(join(passerelle, "rapport.md"), join(racine, "src"), sortie),
    ).rejects.toThrow(AnonymizeError);
  });

  it("accepte un chemin voisin", async () => {
    await expect(
      refuserCheminInterne(join(racine, "rapport.md"), join(racine, "src"), join(racine, "sortie")),
    ).resolves.toBeUndefined();
  });
});
