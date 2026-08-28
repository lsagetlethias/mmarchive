/**
 * Decoupage d une archive de conversation en fragments indexables.
 *
 * Deux regles, dans cet ordre. Un fil est un fragment : sa racine et toutes ses
 * reponses, quelle que soit leur dispersion dans le temps. Ce qui n appartient a
 * aucun fil est regroupe par fenetres consecutives, coupees sur un silence.
 *
 * L ordre compte : le lien de reponse est un signal explicite laisse par les
 * participants, l horloge n est qu une approximation de ce lien pour les canaux
 * ou personne ne repond. Mesure sur l archive de reference, les fragments se
 * ferment sur un silence dans 48,6 % des cas et sur une fin de fil dans 43,1 % ;
 * le plafond de messages, lui, n en ferme aucun, la coupure de taille arrivant
 * toujours avant. C est le silence qui structure, pas le volume.
 *
 * Aucun recouvrement entre fragments. Les deux seules etudes controlees sur le
 * sujet ne lui trouvent aucun benefice mesurable, et nos frontieres sont des
 * frontieres de conversation, pas des coupures arbitraires au milieu d une phrase
 * qu il faudrait reparer. Voir docs/DECISION-RAG.md.
 */

/** Message tel que l index le rend, colonnes brutes comprises. */
export interface ChunkInput {
  readonly ch: number;
  readonly rowid: number;
  readonly create_at: number;
  /** Racine du fil, nulle pour un message qui n en est pas une reponse. */
  readonly root: number | null;
  readonly usr: number | null;
  readonly message: string;
}

export interface Fragment {
  readonly ch: number;
  /** Racine du fil, nulle quand le fragment vient d une fenetre temporelle. */
  readonly root: number | null;
  readonly firstId: number;
  readonly lastId: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly users: readonly number[];
  readonly messages: number;
  /** Rang du morceau quand un fragment trop long a du etre coupe, 0 sinon. */
  readonly part: number;
  readonly text: string;
}

/**
 * Ce qui a ferme un fragment. Seule la simulation s en sert, mais elle doit la
 * tenir du decoupage lui meme : rejouer les regles de rupture a cote pour les
 * compter, c est compter ce qu on croit que le decoupage fait.
 */
export type CloseCause = "silence" | "plafond" | "canal" | "fil" | "taille" | "fin";

export interface ChunkOptions {
  /**
   * Silence au dela duquel une fenetre se ferme. C est la seule variable qui
   * pilote reellement le decoupage, et aucune valeur ne fait consensus : la
   * litterature du desenchevetrement de conversation va de deux minutes a une
   * heure. A regler par la mesure, pas par principe.
   */
  readonly gapMs?: number;
  /** Garde-fou sur les canaux tres bavards, rarement atteint. */
  readonly maxMessages?: number;
  /** Plafond de taille du texte rendu, en caracteres. */
  readonly maxChars?: number;
  /** Appele pour chaque fragment emis, avec ce qui l a ferme. */
  readonly onClose?: (cause: CloseCause) => void;
}

export const CHUNK_DEFAULTS = {
  gapMs: 30 * 60 * 1000,
  maxMessages: 40,
  // ~800 tokens, a 3,7 caracteres par token pour du francais. Ce n est pas une
  // cible a atteindre : la recherche sature bien avant, et allonger un fragment
  // ne le rend pas plus trouvable. C est le point ou un fil devient trop long
  // pour tenir dans le contexte du modele.
  maxChars: 2960,
} as const;

/** En-tete qui donne au fragment le referent que ses messages n ont pas. */
export interface ChunkContext {
  channelName(ch: number): string;
  userName(usr: number | null): string;
  day(createAt: number): string;
}

function entete(
  premier: ChunkInput,
  participants: Iterable<string>,
  context: ChunkContext,
  suite: boolean,
): string {
  return `Canal #${context.channelName(premier.ch)}, ${context.day(premier.create_at)}, participants : ${[...participants].join(", ")}${suite ? " (suite)" : ""}`;
}

function ligne(m: ChunkInput, context: ChunkContext): string {
  return `${context.userName(m.usr)} : ${m.message}`;
}

/**
 * Accumulateur qui connait a tout instant la taille du texte qu il produirait.
 *
 * Estimer cette taille a partir du seul message laisserait passer des fragments
 * plus longs que le plafond : le texte rendu porte aussi un en-tete, qui grandit
 * avec le nombre de participants, et le prefixe d auteur de chaque ligne. Le
 * plafond doit donc porter sur ce qui sera reellement envoye.
 */
class Groupe {
  readonly #context: ChunkContext;
  readonly #messages: ChunkInput[] = [];
  readonly #noms = new Set<string>();
  readonly #users: number[] = [];
  #corps = 0;

  constructor(context: ChunkContext) {
    this.#context = context;
  }

  get vide(): boolean {
    return this.#messages.length === 0;
  }

  get taille(): number {
    return this.#messages.length;
  }

  /** Taille du texte rendu si ce message rejoignait le groupe. */
  tailleAvec(m: ChunkInput): number {
    const premier = this.#messages[0] ?? m;
    const noms = new Set(this.#noms);
    noms.add(this.#context.userName(m.usr));
    // La marge la plus large : un morceau de rang superieur porte « (suite) ».
    const tete = entete(premier, noms, this.#context, true).length;
    return tete + 1 + this.#corps + ligne(m, this.#context).length + 1;
  }

  ajouter(m: ChunkInput): void {
    this.#messages.push(m);
    this.#noms.add(this.#context.userName(m.usr));
    if (m.usr !== null && !this.#users.includes(m.usr)) this.#users.push(m.usr);
    this.#corps += ligne(m, this.#context).length + 1;
  }

  rendre(root: number | null, part: number): Fragment {
    const premier = this.#messages[0];
    const dernier = this.#messages[this.#messages.length - 1];
    if (premier === undefined || dernier === undefined) {
      throw new Error("Un fragment sans message ne devrait jamais etre construit.");
    }
    const lignes = this.#messages.map((m) => ligne(m, this.#context));
    return {
      ch: premier.ch,
      root,
      firstId: premier.rowid,
      lastId: dernier.rowid,
      firstAt: premier.create_at,
      lastAt: dernier.create_at,
      users: [...this.#users],
      messages: this.#messages.length,
      part,
      text: [entete(premier, this.#noms, this.#context, part > 0), ...lignes].join("\n"),
    };
  }
}

interface Coupure {
  /** Ce qui ferme le groupe courant, ou null si ce message le rejoint. */
  rupture(m: ChunkInput, groupe: Groupe): CloseCause | null;
  /** Racine du fragment que ce message rejoindrait. */
  racine(m: ChunkInput): number | null;
}

/**
 * Boucle commune aux deux decoupages. Emet un fragment des que le plafond est
 * atteint, sans attendre la fin du groupe : un fil de plusieurs dizaines de
 * milliers de messages ne doit pas etre tenu en memoire pour etre coupe.
 */
function* decouper(
  messages: Iterable<ChunkInput>,
  context: ChunkContext,
  coupure: Coupure,
  maxChars: number,
  onClose: ((cause: CloseCause) => void) | undefined,
): Generator<Fragment> {
  let groupe = new Groupe(context);
  let racine: number | null = null;
  let part = 0;

  for (const m of messages) {
    // Toujours evalue, y compris sur un groupe vide : c est cet appel qui tient
    // l etat du decoupage a jour, canal courant et date du dernier message.
    const rompt = coupure.rupture(m, groupe);
    if (!groupe.vide && rompt !== null) {
      onClose?.(rompt);
      yield groupe.rendre(racine, part);
      groupe = new Groupe(context);
      part = 0;
    } else if (!groupe.vide && groupe.tailleAvec(m) > maxChars) {
      // Coupure de taille : meme groupe logique, morceau suivant. Un message
      // seul plus grand que le plafond passe entier, le couper le trahirait.
      onClose?.("taille");
      yield groupe.rendre(racine, part);
      groupe = new Groupe(context);
      part += 1;
    }
    racine = coupure.racine(m);
    groupe.ajouter(m);
  }
  if (!groupe.vide) {
    onClose?.("fin");
    yield groupe.rendre(racine, part);
  }
}

/**
 * Fragments des fils. Consomme un flux **trie par (racine, date)**, ce qui suffit
 * a ne jamais tenir en memoire plus d un morceau a la fois.
 */
export function chunkThreads(
  messages: Iterable<ChunkInput>,
  context: ChunkContext,
  options: ChunkOptions = {},
): Generator<Fragment> {
  let courante: number | null = null;
  return decouper(
    messages,
    context,
    {
      rupture: (m) => {
        const sienne = m.root ?? m.rowid;
        const change = courante !== null && sienne !== courante;
        courante = sienne;
        return change ? "fil" : null;
      },
      racine: (m) => m.root ?? m.rowid,
    },
    options.maxChars ?? CHUNK_DEFAULTS.maxChars,
    options.onClose,
  );
}

/**
 * Fragments des messages qui n appartiennent a aucun fil. Consomme un flux
 * **trie par (canal, date)**, et ne retient qu un morceau a la fois.
 */
export function chunkWindows(
  messages: Iterable<ChunkInput>,
  context: ChunkContext,
  options: ChunkOptions = {},
): Generator<Fragment> {
  const gapMs = options.gapMs ?? CHUNK_DEFAULTS.gapMs;
  const maxMessages = options.maxMessages ?? CHUNK_DEFAULTS.maxMessages;
  let canal: number | null = null;
  let dernier = 0;
  return decouper(
    messages,
    context,
    {
      rupture: (m, groupe) => {
        const cause: CloseCause | null =
          m.ch !== canal
            ? "canal"
            : m.create_at - dernier > gapMs
              ? "silence"
              : groupe.taille >= maxMessages
                ? "plafond"
                : null;
        canal = m.ch;
        dernier = m.create_at;
        return cause;
      },
      racine: () => null,
    },
    options.maxChars ?? CHUNK_DEFAULTS.maxChars,
    options.onClose,
  );
}
