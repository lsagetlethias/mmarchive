/**
 * Decoupage d une archive de conversation en fragments indexables.
 *
 * Deux regles, dans cet ordre. Un fil est un fragment : sa racine et toutes ses
 * reponses, quelle que soit leur dispersion dans le temps. Ce qui n appartient a
 * aucun fil est regroupe par fenetres consecutives, coupees sur un silence.
 *
 * L ordre compte : le lien de reponse est un signal explicite laisse par les
 * participants, l horloge n est qu une approximation de ce lien pour les canaux
 * ou personne ne repond. Mesure sur l archive de reference, la coupure temporelle
 * ferme 98,5 % des fenetres et le plafond de messages 0,98 % : c est le silence
 * qui structure, pas le volume.
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
  /** Plafond de taille avant coupure, en caracteres. */
  readonly maxChars?: number;
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

function renderText(
  messages: readonly ChunkInput[],
  context: ChunkContext,
  suite: boolean,
): string {
  const participants = [...new Set(messages.map((m) => context.userName(m.usr)))];
  const first = messages[0];
  if (first === undefined) return "";
  const entete = `Canal #${context.channelName(first.ch)}, ${context.day(first.create_at)}, participants : ${participants.join(", ")}${suite ? " (suite)" : ""}`;
  const corps = messages.map((m) => `${context.userName(m.usr)} : ${m.message}`);
  return [entete, ...corps].join("\n");
}

function buildFragment(
  messages: readonly ChunkInput[],
  root: number | null,
  context: ChunkContext,
  part: number,
): Fragment {
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("Un fragment sans message ne devrait jamais etre construit.");
  }
  const users: number[] = [];
  for (const m of messages) {
    if (m.usr !== null && !users.includes(m.usr)) users.push(m.usr);
  }
  return {
    ch: first.ch,
    root,
    firstId: first.rowid,
    lastId: last.rowid,
    firstAt: first.create_at,
    lastAt: last.create_at,
    users,
    messages: messages.length,
    part,
    text: renderText(messages, context, part > 0),
  };
}

/**
 * Coupe un groupe trop long en morceaux qui tiennent, sans jamais couper au
 * milieu d un message : un message tronque perd son sens et son auteur.
 */
function* split(
  messages: readonly ChunkInput[],
  root: number | null,
  context: ChunkContext,
  maxChars: number,
): Generator<Fragment> {
  let courant: ChunkInput[] = [];
  let taille = 0;
  let part = 0;
  for (const m of messages) {
    const coutMessage = m.message.length + 40;
    if (courant.length > 0 && taille + coutMessage > maxChars) {
      yield buildFragment(courant, root, context, part);
      part += 1;
      courant = [];
      taille = 0;
    }
    courant.push(m);
    taille += coutMessage;
  }
  if (courant.length > 0) yield buildFragment(courant, root, context, part);
}

/**
 * Fragments des fils. Consomme un flux **trie par (racine, date)**, ce qui suffit
 * a ne jamais tenir en memoire plus d un fil a la fois.
 */
export function* chunkThreads(
  messages: Iterable<ChunkInput>,
  context: ChunkContext,
  options: ChunkOptions = {},
): Generator<Fragment> {
  const maxChars = options.maxChars ?? CHUNK_DEFAULTS.maxChars;
  let courant: ChunkInput[] = [];
  let racine: number | null = null;

  for (const m of messages) {
    const sien = m.root ?? m.rowid;
    if (racine !== null && sien !== racine) {
      yield* split(courant, racine, context, maxChars);
      courant = [];
    }
    racine = sien;
    courant.push(m);
  }
  if (courant.length > 0 && racine !== null) yield* split(courant, racine, context, maxChars);
}

/**
 * Fragments des messages qui n appartiennent a aucun fil. Consomme un flux
 * **trie par (canal, date)**, et ne retient qu une fenetre a la fois.
 */
export function* chunkWindows(
  messages: Iterable<ChunkInput>,
  context: ChunkContext,
  options: ChunkOptions = {},
): Generator<Fragment> {
  const gapMs = options.gapMs ?? CHUNK_DEFAULTS.gapMs;
  const maxMessages = options.maxMessages ?? CHUNK_DEFAULTS.maxMessages;
  const maxChars = options.maxChars ?? CHUNK_DEFAULTS.maxChars;

  let courant: ChunkInput[] = [];
  let canal: number | null = null;
  let dernier = 0;

  for (const m of messages) {
    const rupture =
      courant.length > 0 &&
      (m.ch !== canal || m.create_at - dernier > gapMs || courant.length >= maxMessages);
    if (rupture) {
      yield* split(courant, null, context, maxChars);
      courant = [];
    }
    canal = m.ch;
    dernier = m.create_at;
    courant.push(m);
  }
  if (courant.length > 0) yield* split(courant, null, context, maxChars);
}
