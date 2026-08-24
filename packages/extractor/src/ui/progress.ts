import { MultiBar, type SingleBar } from "cli-progress";

export interface ChannelProgressReporter {
  start(total: number): void;
  increment(delta: number): void;
  setTotal(total: number): void;
  stop(): void;
}

export interface ProgressOptions {
  readonly enabled?: boolean;
  readonly out?: NodeJS.WritableStream;
}

const LABEL_WIDTH = 28;
const ELLIPSIS = "...";

function ignore(): void {
  // Aucun rendu quand l affichage est desactive.
}

/** Rapporteur inerte partage: il n a aucun etat, une seule instance suffit. */
const INERT_REPORTER: ChannelProgressReporter = Object.freeze({
  start: ignore,
  increment: ignore,
  setTotal: ignore,
  stop: ignore,
});

function padLabel(label: string): string {
  // Array.from decoupe en points de code: tronquer sur la longueur JavaScript
  // couperait un caractere accentue decompose en deux.
  const chars = Array.from(label);
  if (chars.length > LABEL_WIDTH) {
    return `${chars.slice(0, LABEL_WIDTH - ELLIPSIS.length).join("")}${ELLIPSIS}`;
  }
  return label + " ".repeat(LABEL_WIDTH - chars.length);
}

function normalizeTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

export class ProgressDisplay {
  readonly #multi: MultiBar | null;
  readonly #reporters = new Map<string, ChannelProgressReporter>();
  #barCount = 0;
  #stopped = false;

  constructor(options?: ProgressOptions) {
    // Les barres partent sur stderr: la sortie standard reste redirigeable et
    // greppable sans se faire polluer par des redessins.
    const out = options?.out ?? process.stderr;
    const enabled = options?.enabled ?? process.stderr.isTTY;

    this.#multi = enabled
      ? new MultiBar({
          stream: out,
          format: "  {label} [{bar}] {percentage}% | {value}/{total}",
          barCompleteChar: "=",
          barIncompleteChar: "-",
          barsize: 24,
          clearOnComplete: false,
          // Une extraction dure des heures et finit parfois par un Ctrl-C. Un
          // curseur masque que personne ne restaure laisse le terminal inutilisable,
          // donc on ne le masque jamais, et gracefulExit reactive le retour a la
          // ligne automatique si le processus est interrompu.
          hideCursor: false,
          gracefulExit: true,
        })
      : null;
  }

  /** Ajoute une barre pour un canal, libellee par son nom d affichage. */
  addChannel(channelId: string, label: string): ChannelProgressReporter {
    const existing = this.#reporters.get(channelId);
    if (existing !== undefined) {
      return existing;
    }

    const multi = this.#multi;
    if (multi === null || this.#stopped) {
      return INERT_REPORTER;
    }

    const paddedLabel = padLabel(label);
    let bar: SingleBar | null = null;
    let stopped = false;

    const reporter: ChannelProgressReporter = {
      start: (total: number): void => {
        if (stopped) {
          return;
        }
        if (bar === null) {
          bar = multi.create(normalizeTotal(total), 0, { label: paddedLabel });
          this.#barCount += 1;
        } else {
          bar.setTotal(normalizeTotal(total));
        }
      },
      increment: (delta: number): void => {
        if (stopped || !Number.isFinite(delta)) {
          return;
        }
        bar?.increment(delta);
      },
      setTotal: (total: number): void => {
        if (stopped) {
          return;
        }
        bar?.setTotal(normalizeTotal(total));
      },
      stop: (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        bar?.stop();
      },
    };

    this.#reporters.set(channelId, reporter);
    return reporter;
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    // MultiBar.stop() rend une derniere fois chaque barre puis ecrit un saut de
    // ligne: sans barre creee, ce serait une ligne vide gratuite.
    if (this.#multi !== null && this.#barCount > 0) {
      this.#multi.stop();
    }
  }
}
