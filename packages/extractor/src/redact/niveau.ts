/**
 * Niveaux d anonymisation.
 *
 * Ils existent parce que les etapes n ont pas le meme cout. Pseudonymiser les
 * comptes ne touche a rien de ce qu on lit ; remplacer les noms ecrits en clair
 * abime du texte, puisque aucun ancrage ne distingue un prenom d un mot
 * ordinaire. Un reglage unique obligerait a choisir entre en faire trop pour
 * ceux qui veulent lire et pas assez pour ceux qui doivent diffuser.
 *
 * Chaque niveau contient le precedent. Ce qui les distingue n est pas un degre
 * de zele mais une PROMESSE differente, et le manifeste comme le rapport disent
 * laquelle a ete tenue.
 *
 * Une chose ne depend d aucun niveau et s applique toujours : la substitution
 * des noms que les metadonnees d un message systeme designent. Ce n est pas une
 * reecriture de confort, c est ce qui empeche une ligne d apparier une identite
 * reelle et son pseudonyme. La rendre optionnelle laisserait le niveau le plus
 * bas porter la table de correspondance en clair, ce qui n a de sens a aucun
 * niveau.
 */

export const NIVEAUX = ["comptes", "formes", "noms"] as const;

export type NiveauAnonymisation = (typeof NIVEAUX)[number];

export const NIVEAU_PAR_DEFAUT: NiveauAnonymisation = "noms";

/**
 * Seuil de frequence au dela duquel une forme cesse d etre traitee comme un nom.
 *
 * Une forme qui apparait plus de deux cents fois dans le corpus n est presque
 * jamais une personne citee deux cents fois, c est un mot ordinaire qui se
 * trouve etre aussi un nom de compte. Mesure sur l archive de reference : neuf
 * formes font a elles seules la moitie des occurrences du vocabulaire.
 *
 * C est le point d inflexion mesure. En dessous, la couverture s effondre plus
 * vite que le texte ne se repare ; au dessus, le volume de texte touche double
 * bien plus vite que le nombre de personnes protegees n augmente.
 */
export const SEUIL_FREQUENCE_PAR_DEFAUT = 200;

/** Ce que chaque niveau ajoute, pour l aide de la commande et le rapport. */
export const DESCRIPTION_NIVEAUX: Record<NiveauAnonymisation, string> = {
  comptes:
    "Fiches de comptes, metadonnees et references. Les binaires ne sont pas repris. Les mentions, les adresses et les noms ecrits en clair restent dans le texte ; seuls les noms que les metadonnees d un message designent y sont substitues, ce que tous les niveaux font.",
  formes:
    "Ajoute les formes ancrees du texte : mentions, adresses, numeros de telephone et identifiants colles. Les noms ecrits en clair restent.",
  noms: "Ajoute les noms ecrits en clair, ce qui abime du texte la ou un nom est aussi un mot ordinaire. C est le seul niveau qui vise une diffusion.",
};

export function estNiveau(valeur: string): valeur is NiveauAnonymisation {
  return (NIVEAUX as readonly string[]).includes(valeur);
}

/** Vrai si ce niveau reecrit les formes ancrees du texte. */
export function reecritLesFormes(niveau: NiveauAnonymisation): boolean {
  return niveau !== "comptes";
}

/** Vrai si ce niveau remplace les noms ecrits en clair. */
export function reecritLesNoms(niveau: NiveauAnonymisation): boolean {
  return niveau === "noms";
}
