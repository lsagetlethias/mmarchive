/**
 * Rendu du rapport, en deux documents qui ne s adressent pas au meme lecteur.
 *
 * La SYNTHESE circule : elle va au juriste qui autorise ou non la diffusion, et
 * au mainteneur. Elle ne contient aucune chaine d origine, aucun emplacement,
 * aucune ligne par compte. Elle tient en deux pages de faits chiffres, ce qui
 * est le seul moyen de rendre tenable la charge qu elle laisse a son lecteur.
 *
 * Le RELEVE ne circule pas : il porte les formes et les emplacements, donc il
 * est lui-meme une cle de reidentification. Il ne se produit que sur demande
 * explicite, ou d office quand le controle a trouve des manquements, puisqu il
 * n y a alors rien a diffuser et que le detail est ce qu on cherche.
 *
 * Le rapport ne rend jamais de verdict positif. La preuve est asymetrique : une
 * identite trouvee est une preuve, aucune identite trouvee n en est pas une,
 * puisque le corps des messages, le nom des canaux et celui de la team restent
 * hors perimetre. Et un verdict positif termine la revue : personne ne lit les
 * limites d un document qui s ouvre sur « diffusable ».
 */
import type { AnonymizeResult } from "./anonymize-archive.js";
import { DESCRIPTION_NIVEAUX } from "./niveau.js";
import {
  type CategorieReference,
  effectifPublic,
  partPublique,
  SEUIL_EFFECTIF,
} from "./report-data.js";
import type { ResidualReport } from "./residual-check.js";

export interface ContexteRapport {
  readonly resultat: AnonymizeResult;
  readonly controle: ResidualReport;
  readonly versionOutil: string;
  readonly horodatage: string;
  /** Vrai si un releve a ete produit. Son chemin n y figure jamais. */
  readonly releveProduit: boolean;
}

const LIBELLES: Record<CategorieReference, string> = {
  auteurs: "Auteurs de messages",
  reactions: "Reactions",
  fichiers: "Deposants de pieces jointes",
  emojis: "Createurs d emoji",
};

function tableau(entetes: readonly string[], lignes: readonly (readonly string[])[]): string {
  const bloc = [
    `| ${entetes.join(" | ")} |`,
    `| ${entetes.map(() => "---").join(" | ")} |`,
    ...lignes.map((l) => `| ${l.join(" | ")} |`),
  ];
  return bloc.join("\n");
}

/**
 * Verdict, a deux valeurs et jamais positif.
 *
 * `non_diffusable` se demontre : le controle residuel est positif et ferme sur
 * un ensemble de champs connus, donc une valeur hors de l ensemble de
 * substitution est une preuve. `sans_avis` est tout ce qu on peut dire d autre.
 */
function verdict(contexte: ContexteRapport): { valeur: string; cause: string } {
  const { manquements, mesures } = contexte.controle;
  if (manquements.length > 0) {
    return {
      valeur: "non_diffusable",
      cause: `${String(manquements.length)} identite(s) ont survecu dans des champs qui devaient etre pseudonymises.`,
    };
  }
  if (mesures.nomsResiduelsSysteme > 0) {
    return {
      valeur: "non_diffusable",
      cause:
        `${String(mesures.nomsResiduelsSysteme)} message(s) systeme portent encore le nom en clair d un ` +
        "compte. C est une surface que la passe substitue : en trouver un est un echec de la passe, " +
        "et ces lignes portent par ailleurs des identites de substitution. Ce compte ne dit pas que " +
        "le nom trouve soit celui du compte que la ligne designe, ce qui demanderait la table des " +
        "identites, mais la presence meme du nom suffit a ne pas diffuser.",
    };
  }
  return {
    valeur: "sans_avis",
    cause:
      "Aucune identite n a ete trouvee dans le perimetre couvert. Ce n est pas une autorisation " +
      "de diffuser : le perimetre ouvert, enumere plus bas, n a pas ete mesure et ne peut pas l etre " +
      "par un programme qui ne voit qu un repertoire.",
  };
}

export function rendreSynthese(contexte: ContexteRapport): string {
  const { resultat, controle, versionOutil, horodatage } = contexte;
  const m = controle.mesures;
  const avis = verdict(contexte);
  const lignes: string[] = [];
  const ajouter = (...bloc: string[]): void => {
    lignes.push(...bloc, "");
  };

  ajouter(
    "# Rapport d anonymisation",
    "",
    "**Ce document ne se diffuse pas avec l archive et ne s archive pas avec elle.** Il designe",
    "precisement ce que l anonymisation a cherche a cacher, et ce qu elle n a pas atteint.",
    "",
    `Archive produite le ${horodatage} par mmarchive ${versionOutil}.`,
    "",
    `Niveau appliqué : **${resultat.niveau}**. ${DESCRIPTION_NIVEAUX[resultat.niveau]}`,
  );

  ajouter(
    "## Verdict",
    "",
    `**${avis.valeur}**`,
    "",
    avis.cause,
    "",
    "Ce rapport ne rend jamais de verdict positif. Une identite trouvee est une preuve ; aucune",
    "identite trouvee n en est pas une, puisque le corps des messages, le nom des canaux, celui",
    "des emojis et celui de la team restent hors du perimetre verifiable.",
  );

  ajouter(
    "## Perimetre de la garantie, champs structures",
    "",
    "Compte pendant la passe d anonymisation.",
    "",
    tableau(
      ["Categorie de champ", "References reecrites", "Retirees faute de compte"],
      (Object.keys(LIBELLES) as CategorieReference[]).map((cle) => [
        LIBELLES[cle],
        String(resultat.references[cle].reecrites),
        String(resultat.references[cle].orphelines),
      ]),
    ),
    "",
    "Une reference retiree l est parce que le compte a disparu de l instance ou que sa",
    "recuperation avait echoue a l extraction. La conserver aurait laisse un identifiant reel.",
    "",
    tableau(
      ["Metadonnees des messages", "Nombre"],
      [
        ["Cles retirees hors liste blanche", String(resultat.props.clesRetirees)],
        ["References reecrites", String(resultat.props.referencesReecrites)],
        ["References retirees faute de compte", String(resultat.props.referencesOrphelines)],
        ["Blocs attachments reduits a leur texte", String(resultat.props.attachmentsReduits)],
        ["Noms substitues dans le texte des messages systeme", String(resultat.nomsSubstitues)],
      ],
    ),
  );

  const surface = (nom: string, c: typeof resultat.texteCorps): readonly string[][] => [
    [`${nom} : mentions substituees`, String(c.mentionsSubstituees)],
    [`${nom} : mentions deja traitees en amont`, String(c.mentionsDejaTraitees)],
    [`${nom} : mentions neutralisees, ne designant aucun compte`, String(c.mentionsNeutralisees)],
    [`${nom} : mentions collectives, laissees intactes`, String(c.mentionsCollectives)],
    [`${nom} : adresses retirees`, String(c.adressesRetirees)],
    [`${nom} : numeros retires`, String(c.telephonesRetires)],
    [`${nom} : identifiants de comptes substitues`, String(c.identifiantsSubstitues)],
    [
      `${nom} : identifiants ne designant aucun compte, laisses intacts`,
      String(c.identifiantsIndecidables),
    ],
    [`${nom} : noms ecrits en clair remplaces`, String(c.nomsRemplaces)],
  ];

  ajouter(
    "## Ce qui a ete reecrit dans le texte",
    "",
    "Compte pendant la passe, par surface. Les deux ne se somment pas : le taux de resolution des",
    "mentions y differe d un facteur quarante, et un total decrirait une population qui n existe pas.",
    "",
    tableau(
      ["Surface et forme", "Nombre"],
      [
        ...surface("Corps des messages", resultat.texteCorps),
        ...surface("Blocs attachments", resultat.texteBlocs),
      ],
    ),
    "",
    "Une mention qui ne designe aucun compte est neutralisee plutot que laissee : une mention non",
    "resolue reste un nom. Un identifiant qui ne designe aucun compte est au contraire laisse",
    "intact, et l asymetrie est mesuree : la regle inverse detruirait des milliers de permaliens",
    "que le format conserve deliberement, pour traiter une dizaine de cas.",
  );

  if (resultat.vocabulaire !== undefined) {
    const v = resultat.vocabulaire;
    ajouter(
      "## Le vocabulaire des noms, et ce qu il laisse",
      "",
      "C est la seule etape sans ancrage : un prenom ne se distingue d un mot ordinaire par rien,",
      "et le prix de l erreur n est pas le meme dans les deux sens. Une forme oubliee laisse une",
      "identite, une forme de trop abime du texte.",
      "",
      tableau(
        ["Mesure", "Valeur"],
        [
          ["Formes retenues", String(v.formes.size)],
          [
            "dont partagees par plusieurs comptes, remplacees sans pseudonyme",
            String(v.formesPartagees),
          ],
          ["Formes ecartees comme trop frequentes dans le corpus", String(v.ecarteesParFrequence)],
          ["Comptes dont au moins une forme est remplacee", effectifPublic(v.comptesCouverts)],
          ["Comptes restant nommables en clair", effectifPublic(v.comptesNonCouverts)],
        ],
      ),
      "",
      "Une forme que plusieurs comptes portent ne recoit pas le pseudonyme de l un d eux : cela",
      "attribuerait a une personne les propos qui concernent une autre, ce que le cadrage refuse",
      "explicitement. Elle recoit un substitut neutre, donc le fil est perdu sur ces occurrences.",
      "",
      "**Les comptes restant nommables sont le chiffre a lire.** Leurs formes sont trop courtes,",
      "trop partagees entre comptes, ou trop frequentes dans le corpus pour etre remplacees sans",
      "detruire le texte. Aucun reglage ne les couvre tous : une part d entre eux porte un prenom",
      "que la langue emploie par ailleurs, et les remplacer reviendrait a remplacer le mot.",
    );
  }

  ajouter(
    "## Ce qui n est pas traite a ce stade",
    "",
    "Mesure sur l archive produite. Ces surfaces portent du texte que la passe n a pas reecrit.",
    "",
    tableau(
      ["Surface", "Volume"],
      [
        ["Messages", String(m.messages)],
        ["Mentions rencontrees", String(m.mentions)],
        ["dont deja reecrites vers un pseudonyme", String(m.mentionsPseudonymisees)],
        ["dont portant encore le nom d un compte connu", String(m.mentionsATraiter)],
        ["dont collectives, ne designant personne", String(m.mentionsCollectives)],
        [
          "dont ne designant aucun compte, en formes distinctes",
          String(m.formesNonResolues.length),
        ],
        ["Messages portant une adresse electronique", String(m.messagesAvecAdresse)],
        ["Adresses distinctes", String(m.adressesDistinctes)],
        ["Occurrences ressemblant a un numero de telephone", String(m.telephones)],
        ["Canaux dont le nom porte une identite rare", String(m.canauxDistincts)],
        ["Emojis dont le nom porte une identite rare", String(m.emojisNommes)],
      ],
    ),
    "",
    "Les mentions portant encore le nom d un compte connu sont ce que la reecriture du texte",
    "saura traiter ; celles qui ne designent aucun compte resteront un residu, faute de forme a",
    "laquelle les rattacher.",
    "",
    "Ce qui reste porte sur les NOMS ecrits en clair, que cette passe ne traite pas. Les formes",
    "ancrees, celles qui commencent par un arobase ou qui portent un domaine, sont traitees et",
    "comptees dans la section precedente.",
  );

  if (m.identifiantsCollesMessages > 0) {
    const tronque = m.identifiantsCollesMessages > m.identifiantsColles.length;
    ajouter(
      "## Identifiants de comptes colles dans le corps",
      "",
      `${String(m.identifiantsCollesOccurrences)} occurrence(s) dans ` +
        `${String(m.identifiantsCollesMessages)} message(s).`,
      "Detection par appartenance exacte a l ensemble des identifiants d origine, donc sans faux",
      "positif. La correction est manuelle : le releve les designe un par un.",
      ...(tronque
        ? [
            "",
            `Le releve n en detaille que ${String(m.identifiantsColles.length)}. A ce volume, la`,
            "correction ne se fait plus a la main : les deux totaux ci-dessus sont ce qu il faut lire.",
          ]
        : []),
    );
  }

  ajouter(
    "## Reversibilite par recoupement",
    "",
    "Des distributions, jamais une ligne par compte. Ces chiffres disent ce qu un lecteur qui",
    "connait l organisation peut deduire sans aucun outil.",
    "",
    tableau(
      ["Mesure", "Valeur"],
      [
        [
          "Part du corpus portee par le compte le plus actif",
          partPublique(m.compteLePlusActif, m.messages),
        ],
        ["Comptes au dela de cent messages", effectifPublic(m.comptesAuDessusDeCent)],
      ],
    ),
    "",
    "Le nom de la team est conserve : l organisation n est pas cachee, et ce choix est assume.",
    "Un fil date, situe dans un canal identifiable, avec un enchainement de reponses",
    "caracteristique, peut designer quelqu un pour qui connait le contexte. Aucune",
    "pseudonymisation n y repond.",
  );

  ajouter(
    "## Ce que ce rapport ne mesure pas",
    "",
    ...controle.horsControle.map((limite) => `- ${limite}`),
    "",
    "Angles morts de methode, qui ne se corrigent pas par un reglage :",
    "",
    "- le motif de telephone ne reconnait que les formes francaises, et rate les numeros",
    "  etrangers, ceux ecrits en toutes lettres et ceux coupes par un retour a la ligne ;",
    "- une personne designee par un surnom, une initiale, une orthographe approximative ou une",
    "  signature passe au travers, faute de forme a laquelle la rattacher ;",
    "- les identites contenues dans les images ne sont pas lues ;",
    `- tout effectif inferieur a ${String(SEUIL_EFFECTIF)} est fondu dans une classe plus large,`,
    "  parce qu un decompte a un n est pas un decompte mais une designation.",
  );

  if (contexte.releveProduit) {
    ajouter(
      "## Releve detaille",
      "",
      "Un releve a ete produit a cote de ce document. Il porte les formes residuelles et leurs",
      "emplacements, donc il est lui-meme une cle de reidentification : il ne se diffuse pas, ne",
      "s archive pas, et doit etre detruit une fois les corrections faites.",
    );
  }

  return `${lignes.join("\n").trimEnd()}\n`;
}

/**
 * Releve, en NDJSON.
 *
 * Une ligne d en-tete qui dit ce qu est le fichier, puis une ligne par entree.
 * Le format se filtre au `grep` et supporte des milliers de lignes, ce que le
 * Markdown ne fait pas.
 */
export function rendreReleve(contexte: ContexteRapport): string {
  const m = contexte.controle.mesures;
  const lignes: unknown[] = [
    {
      _: "RELEVE D IDENTITES RESIDUELLES. NE PAS DIFFUSER, NE PAS ARCHIVER AVEC L ARCHIVE. Ce fichier porte les formes et les emplacements que l anonymisation n a pas traites : il est une cle de reidentification. A detruire une fois les corrections faites.",
      produit_le: contexte.horodatage,
      outil: contexte.versionOutil,
    },
  ];

  // Les canaux d abord : c est la seule rubrique sur laquelle l operateur agit
  // AVANT de diffuser, en renommant ou en excluant a la main.
  for (const candidat of m.canauxCandidats) {
    lignes.push({ rubrique: "canal_candidat", ...candidat });
  }
  for (const manquement of contexte.controle.manquements) {
    lignes.push({ rubrique: "manquement", ...manquement });
  }
  for (const forme of m.formesNonResolues) {
    lignes.push({ rubrique: "mention_non_resolue", ...forme });
  }
  for (const colle of m.identifiantsColles) {
    lignes.push({ rubrique: "identifiant_colle", ...colle });
  }

  return `${lignes.map((l) => JSON.stringify(l)).join("\n")}\n`;
}
