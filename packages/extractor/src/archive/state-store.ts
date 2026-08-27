import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type ChannelProgress,
  createChannelProgress,
  createEmptyState,
  type ExtractState,
  extractStateSchema,
  STATE_VERSION,
} from "@mmarchive/shared";

/**
 * Horloge injectable. Elle alimente `updated_at` a chaque ecriture et la
 * fenetre de `saveThrottled`, pour que les tests soient deterministes sans
 * dependre de l heure reelle.
 */
export type Clock = () => Date;

export interface StateStoreOptions {
  clock?: Clock;
}

const DEFAULT_SAVE_INTERVAL_MS = 5_000;

const systemClock: Clock = () => new Date();

export type StateMismatchReason = "source_url" | "account" | "options" | "version";

export class StateMismatchError extends Error {
  readonly reason: StateMismatchReason;

  constructor(reason: StateMismatchReason, message: string) {
    super(message);
    this.name = "StateMismatchError";
    this.reason = reason;
  }
}

export class StateCorruptedError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string, cause: unknown) {
    super(
      `Etat de reprise illisible (${filePath}) : ${detail}. ` +
        "Le fichier est corrompu ou n a pas ete produit par cette version de l outil. " +
        "Relancez l extraction sans --resume pour repartir d un etat neuf, " +
        "apres avoir mis ce fichier de cote si vous avez besoin de la liste des canaux rejoints.",
      { cause },
    );
    this.name = "StateCorruptedError";
    this.filePath = filePath;
  }
}

export class StateStore {
  readonly state: ExtractState;

  private readonly filePath: string;
  private readonly clock: Clock;
  private dirty: boolean;
  /**
   * Ancre de la fenetre de throttling, posee des la DECISION d ecrire et pas a
   * la fin de l ecriture : plusieurs canaux extraits de front appellent
   * saveThrottled dans le meme tick, et une ancre posee trop tard les laisserait
   * tous franchir la porte pour declencher autant de fsync que d appelants.
   */
  private throttleAnchorMs: number | null = null;
  /** Chaine de serialisation : deux ecritures ne doivent jamais s entrelacer. */
  private writeChain: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, state: ExtractState, dirty: boolean, clock: Clock) {
    this.filePath = filePath;
    this.state = state;
    this.dirty = dirty;
    this.clock = clock;
  }

  /**
   * Charge un etat existant. Renvoie null si le fichier n existe pas.
   * Leve StateMismatchError si l etat ne correspond pas a la cible demandee :
   * reprendre une extraction avec un autre serveur, un autre compte ou d autres
   * options produirait une archive incoherente.
   */
  static async load(
    filePath: string,
    expected: { sourceUrl: string; accountId: string; optionsFingerprint: string },
    options?: StateStoreOptions,
  ): Promise<StateStore | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StateCorruptedError(filePath, "JSON invalide", error);
    }

    // Le controle de version precede la validation par le schema : une version
    // future aura une forme differente, et la faire echouer sur le schema de la
    // version courante annoncerait une corruption la ou il n y a qu un ecart de
    // version.
    const declaredVersion = readDeclaredVersion(parsed);
    if (declaredVersion !== null && declaredVersion !== STATE_VERSION) {
      throw new StateMismatchError(
        "version",
        `Etat de reprise en version ${String(declaredVersion)}, cet outil attend la version ` +
          `${String(STATE_VERSION)}. Relancez sans --resume.`,
      );
    }

    const result = extractStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new StateCorruptedError(filePath, describeZodIssues(result.error), result.error);
    }
    const state = result.data;

    if (state.source_url !== expected.sourceUrl) {
      throw new StateMismatchError(
        "source_url",
        `Etat de reprise produit depuis ${state.source_url}, la cible demandee est ` +
          `${expected.sourceUrl}. Reprendre ici rejoindrait des canaux au hasard.`,
      );
    }
    if (state.account_id !== expected.accountId) {
      throw new StateMismatchError(
        "account",
        "Etat de reprise produit par un autre compte. Les droits de lecture different, " +
          "l archive serait incoherente. Relancez sans --resume.",
      );
    }
    if (state.options_fingerprint !== expected.optionsFingerprint) {
      throw new StateMismatchError(
        "options",
        "Etat de reprise produit avec d autres options d extraction. Melanger les deux " +
          "donnerait une archive partiellement conforme a chacune. Relancez sans --resume.",
      );
    }

    return new StateStore(filePath, state, false, options?.clock ?? systemClock);
  }

  static create(
    filePath: string,
    init: {
      startedAt: string;
      sourceUrl: string;
      accountId: string;
      optionsFingerprint: string;
    },
    options?: StateStoreOptions,
  ): StateStore {
    // dirty des la creation : rien n existe encore sur disque, close() doit ecrire
    // meme si aucun canal n a ete traite.
    return new StateStore(filePath, createEmptyState(init), true, options?.clock ?? systemClock);
  }

  /**
   * Marque l etat comme modifie. L ecriture est differee jusqu au prochain
   * saveThrottled, saveNow ou close : tant que ce drapeau est leve, aucune de
   * ces trois portes ne peut laisser la modification sur le carreau.
   */
  touch(): void {
    this.dirty = true;
  }

  /** Ecrit immediatement, de facon atomique. A appeler apres tout join. */
  async saveNow(): Promise<void> {
    await this.enqueueWrite();
  }

  /**
   * Sauvegarde au plus une fois toutes les intervalMs, appels concurrents
   * compris. Pour les mises a jour de curseur, tres frequentes, ou une ecriture
   * par page serait du gaspillage. Un appel etouffe laisse l etat marque comme
   * modifie : la modification part au prochain appel hors fenetre, ou au plus
   * tard dans close().
   */
  async saveThrottled(intervalMs: number = DEFAULT_SAVE_INTERVAL_MS): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const now = this.clock().getTime();
    if (this.throttleAnchorMs !== null && now - this.throttleAnchorMs < intervalMs) {
      return;
    }
    this.throttleAnchorMs = now;
    await this.enqueueWrite();
  }

  /**
   * Vide la sauvegarde en attente et ecrit. A appeler en fin de run et sur
   * SIGINT. Rejette si la derniere ecriture n a pas abouti : l appelant doit
   * savoir que l etat n est pas sur disque.
   */
  async close(): Promise<void> {
    // On attend d abord ce qui est deja en vol. Une ecriture en cours a deja
    // abaisse le drapeau dirty ; si elle echoue elle le releve, et c est a close
    // de reprendre la main plutot que de resoudre sur un etat que personne n a
    // pose sur disque.
    await this.writeChain;
    if (this.dirty) {
      await this.enqueueWrite();
    }
  }

  progressFor(channelId: string): ChannelProgress {
    // hasOwn et pas un acces indexe nu : `channels` est un objet litteral, et un
    // identifiant venu d un YAML edite a la main comme "constructor" resoudrait
    // sur Object.prototype, rendant la progression de ce canal ineffacable et
    // non enregistrable.
    const existing = Object.hasOwn(this.state.channels, channelId)
      ? this.state.channels[channelId]
      : undefined;
    if (existing !== undefined) {
      return existing;
    }
    const created = createChannelProgress();
    this.state.channels[channelId] = created;
    this.touch();
    return created;
  }

  updateProgress(channelId: string, patch: Partial<ChannelProgress>): void {
    // Mutation en place plutot que remplacement : une boucle d extraction garde
    // la progression d un canal pendant toute sa pagination, un nouvel objet a
    // chaque patch lui laisserait une reference orpheline qu elle croirait a jour.
    Object.assign(this.progressFor(channelId), patch);
    this.touch();
  }

  private enqueueWrite(): Promise<void> {
    const run = this.writeChain.then(
      () => this.writeStateFile(),
      () => this.writeStateFile(),
    );
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async writeStateFile(): Promise<void> {
    this.state.updated_at = this.clock().toISOString();
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    // La serialisation est synchrone : tout ce qui est marque a cet instant est
    // dans payload, le drapeau peut retomber avant le premier await.
    this.dirty = false;

    const directory = dirname(this.filePath);
    const temporaryPath = join(
      directory,
      `${basename(this.filePath)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
    );

    try {
      await mkdir(directory, { recursive: true });
      const handle = await open(temporaryPath, "w");
      try {
        await handle.writeFile(payload, "utf8");
        // fsync avant rename : sans lui, une coupure de courant peut laisser un
        // fichier renomme mais vide, donc la liste des canaux rejoints perdue.
        //
        // Ce qui n est pas garanti, et qui est assume. L entree de repertoire
        // creee par le rename ci dessous n est pas synchronisee : apres une
        // coupure brutale de la machine, le contenu peut etre sur le disque
        // pendant que le repertoire designe encore la version precedente. Il
        // faudrait pour cela ouvrir le repertoire parent et le synchroniser a
        // son tour.
        //
        // Deux raisons de s en passer. La consequence se limite a un etat en
        // retard d une sauvegarde, cas que la reprise traite deja en recomptant
        // les lignes reellement ecrites plutot qu en croyant l etat, et qui a
        // son test. Et sur macOS, fsync ne vide pas le cache du disque, ce que
        // seul F_FULLFSYNC obtient : ajouter une synchronisation de repertoire
        // y afficherait une durabilite que la plateforme ne tient pas.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      this.throttleAnchorMs = this.clock().getTime();
    } catch (error) {
      this.dirty = true;
      // L echec du nettoyage ne doit jamais masquer la cause affichee a
      // l utilisateur : c est elle qui dit quoi faire.
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error.code === code;
  }
  return false;
}

function readDeclaredVersion(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    return null;
  }
  const value: unknown = parsed.version;
  return typeof value === "number" ? value : null;
}

function describeZodIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  const shown = error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join(".");
      return path === "" ? issue.message : `${path} : ${issue.message}`;
    })
    .join(" ; ");
  const rest = error.issues.length - 3;
  return rest > 0 ? `${shown} (et ${String(rest)} autres problemes)` : shown;
}
