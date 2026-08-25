const CLEAR_LINE = "\r\u001B[2K";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Duree lisible : 3h10, 12:34, 45s. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "inconnu";
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h${pad(minutes)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("fr-FR");
}

export interface RunReporterOptions {
  /** Messages attendus, d apres les compteurs de l inventaire. */
  readonly estimatedMessages: number;
  readonly out?: NodeJS.WritableStream | undefined;
  /** Rafraichissement de la ligne de statut. */
  readonly intervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Force le mode interactif. Par defaut, deduit du TTY : hors TTY on ajoute une
   * ligne au lieu de reecrire la meme, sinon un fichier de log se remplit de
   * codes d echappement illisibles.
   */
  readonly interactive?: boolean | undefined;
}

/**
 * Etat d avancement d une extraction longue.
 *
 * Sur un run de plusieurs heures, l absence de retour est indistinguable d un
 * blocage : il faut voir en permanence ou en est le travail, a quel debit, et
 * combien de temps il reste.
 */
export class RunReporter {
  private readonly out: NodeJS.WritableStream;
  private readonly estimatedMessages: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly interactive: boolean;
  private readonly startedAt: number;

  private channelsDone = 0;
  private messages = 0;
  private files = 0;
  private requests = 0;
  private phaseLabel = "Preparation";
  private phaseDone = 0;
  private phaseTotal = 0;
  private phaseEstimates = false;
  private lastRenderAt = 0;
  private lineShown = false;
  private timer: NodeJS.Timeout | undefined;
  private current = "";

  constructor(options: RunReporterOptions) {
    this.out = options.out ?? process.stdout;
    this.estimatedMessages = Math.max(options.estimatedMessages, 0);
    this.intervalMs = options.intervalMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
    this.interactive = options.interactive ?? process.stdout.isTTY;
    this.startedAt = this.now();
  }

  /** Rafraichit la ligne meme quand rien ne bouge, pour montrer que le run vit. */
  start(): void {
    this.render(true);
    if (this.interactive && this.timer === undefined) {
      this.timer = setInterval(() => {
        this.render(true);
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  /**
   * Declare l etape en cours.
   *
   * Un run ne commence pas par les canaux : les emojis personnalises sont
   * telecharges d abord, ce qui peut prendre une minute. Sans nommer l etape,
   * l affichage resterait a "0 canaux, 0 messages" et serait indistinguable
   * d un blocage.
   */
  phase(label: string, total = 0, options: { estimate?: boolean } = {}): void {
    this.phaseLabel = label;
    this.phaseTotal = total;
    this.phaseDone = 0;
    this.current = "";
    // Le temps restant se deduit des messages : l afficher pendant une etape qui
    // n en produit plus donnerait un chiffre fige et trompeur.
    this.phaseEstimates = options.estimate ?? false;
    this.render(true);
  }

  /** Ajuste le total d une etape dont la taille n est connue qu au demarrage. */
  phaseTotalIs(total: number): void {
    this.phaseTotal = total;
  }

  phaseProgress(done: number): void {
    this.phaseDone = done;
    this.render();
  }

  channelStarted(label: string): void {
    this.current = label;
    this.render();
  }

  channelFinished(messages: number): void {
    this.channelsDone += 1;
    this.phaseDone = this.channelsDone;
    this.messages += messages;
    this.render(true);
  }

  filesAdded(count: number): void {
    this.files += count;
    this.render();
  }

  /** Requetes HTTP emises, pour afficher le debit reel. */
  setRequestCount(count: number): void {
    this.requests = count;
  }

  /** Ecrit un message sans laisser la ligne de statut a moitie effacee. */
  note(message: string): void {
    this.clearLine();
    this.out.write(`${message}\n`);
    this.render(true);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearLine();
  }

  /** Ligne de statut courante. Exposee pour les tests. */
  statusLine(): string {
    const elapsed = this.now() - this.startedAt;
    const parts = [`[${formatDuration(elapsed)}]`];

    parts.push(
      this.phaseTotal > 0
        ? `${this.phaseLabel} ${formatCount(this.phaseDone)}/${formatCount(this.phaseTotal)}`
        : this.phaseLabel,
    );

    if (this.messages > 0) parts.push(`${formatCount(this.messages)} messages`);
    if (this.files > 0) parts.push(`${formatCount(this.files)} fichiers`);

    const seconds = elapsed / 1000;
    if (seconds >= 1 && this.requests > 0) {
      parts.push(`${(this.requests / seconds).toFixed(1)} req/s`);
    }

    if (this.phaseEstimates) {
      const remaining = this.estimateRemainingMs(elapsed);
      if (remaining !== undefined) parts.push(`reste ~${formatDuration(remaining)}`);
    }
    if (this.current.length > 0) parts.push(this.current);
    return parts.join("  ");
  }

  /**
   * Estimation fondee sur les messages, pas sur les canaux : leurs tailles sont
   * tres inegales, et compter les canaux donnerait un temps restant absurde tant
   * qu un gros canal n est pas termine.
   */
  private estimateRemainingMs(elapsed: number): number | undefined {
    if (this.messages <= 0 || this.estimatedMessages <= 0) return undefined;
    if (this.messages >= this.estimatedMessages) return 0;
    const rate = this.messages / elapsed;
    if (!Number.isFinite(rate) || rate <= 0) return undefined;
    return (this.estimatedMessages - this.messages) / rate;
  }

  private clearLine(): void {
    if (this.interactive && this.lineShown) {
      this.out.write(CLEAR_LINE);
      this.lineShown = false;
    }
  }

  private render(force = false): void {
    const now = this.now();
    if (!force && now - this.lastRenderAt < this.intervalMs) return;
    this.lastRenderAt = now;

    if (this.interactive) {
      this.out.write(`${CLEAR_LINE}${this.statusLine()}`);
      this.lineShown = true;
      return;
    }
    // Hors TTY, on n ecrit qu aux paliers pour ne pas noyer le journal.
    if (force) this.out.write(`${this.statusLine()}\n`);
  }
}
