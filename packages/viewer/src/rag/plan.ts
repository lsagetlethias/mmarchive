/**
 * Ce que le decoupage produirait, sans rien envoyer nulle part.
 *
 * L interet n est pas le total mais la comparaison : faire varier la coupure
 * temporelle et voir bouger la distribution est le seul moyen de la regler, la
 * litterature n offrant aucun consensus. Voir docs/DECISION-RAG.md.
 *
 * Tout est parcouru en flux. A plus d un million de messages, charger la table
 * pour la compter reviendrait a tenir l archive entiere en memoire, ce que le
 * projet s interdit partout ailleurs. Le RAG ne passe donc pas par la couche de
 * requetes isomorphe, qui ne sait rendre que des tableaux : il n en a pas besoin,
 * puisqu il ne tourne jamais dans un navigateur.
 */
import type { DatabaseSync } from "node:sqlite";
import { type ChunkOptions, type CloseCause, chunkThreads, chunkWindows } from "./chunk.js";
import {
  contexteDepuis,
  lisant,
  ORDRE_CANAUX,
  ORDRE_FILS,
  parcourir,
  racines,
  seulementFils,
  seulementIsoles,
} from "./read.js";

/**
 * Caracteres par token. Approximation pour du francais : le tokenizer reel du
 * service retenu donnera un autre chiffre, ce qui deplace le cout annonce sans
 * rien changer aux comparaisons entre deux reglages.
 */
export const CHARS_PER_TOKEN = 3.7;

export interface PlanReport {
  /** Fragments issus de fils, apres coupure : un fil long en produit plusieurs. */
  readonly threads: number;
  /** Fragments issus de fenetres temporelles, apres coupure. */
  readonly windows: number;
  readonly fragments: number;
  readonly tokens: number;
  readonly median: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  /**
   * Ce qui a ferme chaque fragment, tel que le decoupage l a decide. Les causes
   * couvrent tous les fragments emis : leur somme vaut `fragments`.
   */
  readonly closedBy: Readonly<Record<CloseCause, number>>;
}

/**
 * Centile par rang le plus proche. `floor(n * p)` decale d un cran vers le haut :
 * sur dix valeurs, il fait pointer le 90e centile sur le maximum.
 */
function centile(tri: readonly number[], p: number): number {
  if (tri.length === 0) return 0;
  const rang = Math.ceil(p * tri.length) - 1;
  return tri[Math.min(tri.length - 1, Math.max(0, rang))] ?? 0;
}

export function planChunks(db: DatabaseSync, options: ChunkOptions = {}): PlanReport {
  const connues = lisant(() => racines(db));
  const contexte = lisant(() => contexteDepuis(db));

  // Une seule liste de tailles est conservee, pas les fragments eux memes : ce
  // sont des nombres, la ou le texte pese l archive entiere.
  const tailles: number[] = [];
  let threads = 0;
  let windows = 0;
  const closedBy: Record<CloseCause, number> = {
    silence: 0,
    plafond: 0,
    canal: 0,
    fil: 0,
    taille: 0,
    fin: 0,
  };
  const onClose = (cause: CloseCause): void => {
    closedBy[cause] += 1;
  };

  const fils = seulementFils(parcourir(db, ORDRE_FILS), connues);
  lisant(() => {
    for (const f of chunkThreads(fils, contexte, { ...options, onClose })) {
      tailles.push(f.text.length);
      threads += 1;
    }
  });

  const isoles = seulementIsoles(parcourir(db, ORDRE_CANAUX), connues);
  lisant(() => {
    for (const f of chunkWindows(isoles, contexte, { ...options, onClose })) {
      tailles.push(f.text.length);
      windows += 1;
    }
  });

  const tri = tailles.sort((a, b) => a - b);
  const chars = tri.reduce((a, b) => a + b, 0);
  const enTokens = (n: number): number => Math.round(n / CHARS_PER_TOKEN);

  return {
    threads,
    windows,
    fragments: tri.length,
    tokens: Math.round(chars / CHARS_PER_TOKEN),
    median: enTokens(centile(tri, 0.5)),
    p90: enTokens(centile(tri, 0.9)),
    p99: enTokens(centile(tri, 0.99)),
    max: enTokens(tri[tri.length - 1] ?? 0),
    mean: tri.length === 0 ? 0 : enTokens(chars / tri.length),
    closedBy,
  };
}
