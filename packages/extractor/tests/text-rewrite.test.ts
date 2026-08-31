import { describe, expect, it } from "vitest";
import type { Identite } from "../src/redact/identity-table.js";
import type { ResolveurIdentite } from "../src/redact/props-filter.js";
import {
  ADRESSE_RETIREE,
  type CompteursTexte,
  compteursTexteVides,
  MENTION_RETIREE,
  reecrireFormesAncrees,
  TELEPHONE_RETIRE,
} from "../src/redact/text-rewrite.js";

const ALICE: Identite = {
  uid: "a".repeat(26),
  pseudonyme: "Anon-Quartz-Agile",
  username: "anon-quartz-agile",
};
const ORIGINE = "u".repeat(26);

const resolveur: ResolveurIdentite = {
  parId: (id) => (id === ORIGINE ? ALICE : undefined),
  parUsername: (nom) => (nom.toLowerCase() === "alice.martin" ? ALICE : undefined),
  estSubstitution: (nom) => nom.toLowerCase() === ALICE.username,
  uidPourIdentifiant: (id) => (id === ORIGINE ? ALICE.uid : undefined),
};

function reecrire(texte: string): { texte: string; compteurs: CompteursTexte } {
  const compteurs = compteursTexteVides();
  return { texte: reecrireFormesAncrees(texte, resolveur, compteurs), compteurs };
}

describe("les mentions", () => {
  it("substitue celle qui designe un compte, et garde le fil lisible", () => {
    const { texte, compteurs } = reecrire("merci @alice.martin pour la revue");
    expect(texte).toBe(`merci @${ALICE.username} pour la revue`);
    expect(compteurs.mentionsSubstituees).toBe(1);
  });

  it("garde la ponctuation finale hors du nom, comme Mattermost", () => {
    expect(reecrire("vu avec @alice.martin.").texte).toBe(`vu avec @${ALICE.username}.`);
  });

  it("neutralise celle qui ne designe aucun compte, un nom restant un nom", () => {
    const { texte, compteurs } = reecrire("cc @quelqu-un-dautre");
    expect(texte).toBe(`cc ${MENTION_RETIREE}`);
    expect(compteurs.mentionsNeutralisees).toBe(1);
  });

  it("laisse intactes les mentions collectives, qui ne designent personne", () => {
    // Sans regle explicite elles tombent dans la neutralisation, ce qui abime
    // 3 585 messages de l archive de reference pour zero identite.
    const { texte, compteurs } = reecrire("@channel et @here et @all");
    expect(texte).toBe("@channel et @here et @all");
    expect(compteurs.mentionsCollectives).toBe(3);
  });

  it("reconnait un nom deja substitue au lieu de le prendre pour un orphelin", () => {
    // La passe des messages systeme a deja substitue 16 422 mentions en amont.
    // Sans ce test, celle-ci les neutraliserait, et la destruction se lirait
    // comme du travail utile.
    const { texte, compteurs } = reecrire(`deja traite @${ALICE.username}`);
    expect(texte).toBe(`deja traite @${ALICE.username}`);
    expect(compteurs.mentionsDejaTraitees).toBe(1);
    expect(compteurs.mentionsNeutralisees).toBe(0);
  });

  it("capture un nom accentue en entier", () => {
    // Une classe ASCII coupe « @Stephane » sur son accent et n en garde que le
    // debut, ce qui laisse la queue du nom en clair : 657 mentions de l archive
    // de reference etaient ainsi tronquees.
    expect(reecrire("bonjour @Stéphane").texte).toBe(`bonjour ${MENTION_RETIREE}`);
  });

  it("ne laisse pas passer un nom precede d un point, d un tiret ou d un arobase", () => {
    // 127 occurrences de l archive de reference ou un nom de compte suit un
    // arobase, dont 65 apres un second arobase et 59 apres un point. L ancien
    // ancrage les rendait invisibles.
    //
    // Les trois ne se traitent pas de la meme facon, et c est correct :
    // « x.@alice.martin » est une adresse plausible, dont le domaine serait
    // « alice.martin », donc la regle des adresses la prend. Le fil est perdu,
    // l identite ne l est pas, et c est l arbitrage du cadrage.
    expect(reecrire("@@alice.martin").texte).toBe(`@@${ALICE.username}`);
    for (const avant of [".", "-"]) {
      const { texte } = reecrire(`x${avant}@alice.martin`);
      expect(texte, avant).toBe(ADRESSE_RETIREE);
      expect(texte, avant).not.toContain("alice");
    }
  });
});

describe("les adresses", () => {
  it("retire l adresse entiere", () => {
    const { texte, compteurs } = reecrire("ecris a bob@exemple.org stp");
    expect(texte).toBe(`ecris a ${ADRESSE_RETIREE} stp`);
    expect(compteurs.adressesRetirees).toBe(1);
  });

  it("ne laisse pas de chevron, qui casserait un lien markdown", () => {
    // `[Alice](mailto:<redacted>)` produit un lien de contact cliquable, et le
    // chevron coupe le lien la ou il est pose. 2 861 adresses de l archive de
    // reference vivent dans une destination de lien.
    const { texte } = reecrire("[Alice](mailto:bob@exemple.org)");
    expect(texte).not.toContain("<");
    expect(texte).not.toContain("@");
  });

  it("consomme une chaine d arobases en une fois", () => {
    // Sans repetition du domaine, le substitut se recolle au reste et
    // `adresse-retiree@suite.org` est encore une adresse. Le moteur ne relit pas
    // ce qu il vient d ecrire, donc rien ne rattrape.
    const { texte } = reecrire("voir bob@exemple.org@suite.org ici");
    expect(texte).toBe(`voir ${ADRESSE_RETIREE} ici`);
  });

  it("garde le fil quand la forme @local@domaine designe un compte", () => {
    const { texte, compteurs } = reecrire("cc @alice.martin@exemple.org");
    expect(texte).toBe(`cc @${ALICE.username}`);
    expect(compteurs.mentionsSubstituees).toBe(1);
  });

  it("ne prend pas une adresse pour une mention", () => {
    const { compteurs } = reecrire("bob@exemple.org");
    expect(compteurs.mentionsNeutralisees).toBe(0);
    expect(compteurs.adressesRetirees).toBe(1);
  });
});

describe("les numeros et les identifiants", () => {
  it("retire un numero ecrit avec un separateur coherent", () => {
    const { texte, compteurs } = reecrire("appelle le 06 12 34 56 78");
    expect(texte).toBe(`appelle le ${TELEPHONE_RETIRE}`);
    expect(compteurs.telephonesRetires).toBe(1);
  });

  it("ne touche pas a un identifiant technique qui n en est pas un", () => {
    expect(reecrire("poste def_01-23456789").texte).toBe("poste def_01-23456789");
  });

  it("substitue un identifiant de compte colle dans le corps", () => {
    const { texte, compteurs } = reecrire(`voir ${ORIGINE} pour le detail`);
    expect(texte).toBe(`voir ${ALICE.uid} pour le detail`);
    expect(compteurs.identifiantsSubstitues).toBe(1);
  });

  it("laisse intact un identifiant qui ne designe aucun compte", () => {
    // La regle inverse, juste dans les metadonnees, detruirait ici 10 523 jetons
    // sur 10 534, dont 6 566 permaliens conserves deliberement, pour en traiter
    // onze.
    const permalien = `https://exemple.org/pl/${"z".repeat(26)}`;
    const { texte, compteurs } = reecrire(permalien);
    expect(texte).toBe(permalien);
    expect(compteurs.identifiantsIndecidables).toBe(1);
  });
});

describe("l idempotence", () => {
  it("ne bouge plus quand on repasse sur son propre resultat", () => {
    // Les valeurs injectees sont tirees des alphabets memes que les detecteurs
    // lisent : l identifiant de substitution a la forme d un identifiant, le nom
    // de substitution est un corps de mention et une partie locale d adresse
    // valides. C est l alternation unique qui garantit ceci, pas une propriete
    // des pseudonymes.
    const source = [
      "merci @alice.martin",
      "ecris a bob@exemple.org",
      "appelle le 06 12 34 56 78",
      `voir ${ORIGINE}`,
      "cc @inconnu et @channel",
      "melange bob@exemple.org@suite.fr et @alice.martin.",
    ].join("\n");
    const une = reecrire(source).texte;
    const deux = reecrire(une).texte;
    expect(deux).toBe(une);
    // Et rien ne s est passe au second tour.
    const compteurs = reecrire(une).compteurs;
    expect(compteurs.mentionsNeutralisees).toBe(0);
    expect(compteurs.adressesRetirees).toBe(0);
    expect(compteurs.telephonesRetires).toBe(0);
    expect(compteurs.identifiantsSubstitues).toBe(0);
  });

  it("rend une chaine vide inchangee", () => {
    expect(reecrire("").texte).toBe("");
  });
});
