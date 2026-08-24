/**
 * Limiteur a jetons du client HTTP Mattermost.
 *
 * Mattermost limite par defaut a 10 requetes par seconde et par utilisateur.
 * Une extraction complete dure des heures et emet des centaines de milliers de
 * requetes : le limiteur doit rester exact sur toute sa duree de vie, sans
 * jamais deriver, et servir les appelants concurrents dans leur ordre d arrivee
 * sous peine d en affamer certains indefiniment.
 */

export interface RateLimiterOptions {
  /** Requetes par seconde autorisees en regime permanent. */
  readonly requestsPerSecond: number;
  /** Jetons accumulables, donc taille de la rafale initiale. Defaut: requestsPerSecond. */
  readonly burst?: number;
  /** Injectable pour les tests. Defaut: () => Date.now(). */
  readonly now?: () => number;
  /** Injectable pour les tests. Defaut: setTimeout promisifie. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Les timers Node sont stockes sur un entier signe 32 bits. Au dela, setTimeout
 * emet un TimeoutOverflowWarning et se declenche apres 1 ms au lieu d attendre.
 */
const MAX_TIMER_DELAY = 2_147_483_647;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function defaultNow(): number {
  return Date.now();
}

export class TokenBucketRateLimiter {
  readonly #requestsPerSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #waiting: Waiter[] = [];

  #tokens: number;
  #lastRefillAt: number;
  #pausedUntil = 0;
  #draining = false;

  constructor(options: RateLimiterOptions) {
    const { requestsPerSecond } = options;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new RangeError(
        `Limiteur de debit invalide : requestsPerSecond doit etre un nombre fini strictement positif, recu ${String(requestsPerSecond)}.`,
      );
    }

    if (options.burst !== undefined && (!Number.isFinite(options.burst) || options.burst <= 0)) {
      throw new RangeError(
        `Limiteur de debit invalide : burst doit etre un nombre fini strictement positif, recu ${String(options.burst)}.`,
      );
    }
    if (options.burst !== undefined && options.burst < 1) {
      throw new RangeError(
        `Limiteur de debit invalide : burst vaut ${String(options.burst)}, un seau qui ne peut pas contenir un jeton entier ne delivrerait jamais rien.`,
      );
    }

    // Le defaut suit requestsPerSecond, mais reste plancher a 1 : un debit
    // inferieur a une requete par seconde donnerait sinon un seau incapable de
    // contenir un jeton entier.
    this.#burst = options.burst ?? Math.max(1, requestsPerSecond);
    this.#requestsPerSecond = requestsPerSecond;
    this.#now = options.now ?? defaultNow;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#tokens = this.#burst;
    this.#lastRefillAt = this.#now();
  }

  /**
   * Attend qu un jeton soit disponible, puis le consomme. Ne rejette que si
   * l attente elle-meme echoue, auquel cas tous les appelants en file sont
   * rejetes ensemble : le limiteur ne sait plus planifier, les laisser en
   * attente les suspendrait pour toujours.
   */
  acquire(): Promise<void> {
    // Un appelant ne double personne : des qu une file existe, il s y range,
    // meme si un jeton est libre.
    if (this.#waiting.length === 0 && this.#millisecondsUntilAvailable() === 0) {
      this.#tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      void this.#drain();
    });
  }

  /**
   * Suspend toute delivrance de jeton pendant la duree donnee. Utilise a la
   * reception d un 429 avec Retry-After: le serveur fait autorite, on ne
   * discute pas.
   */
  pauseFor(milliseconds: number): void {
    // Un NaN qui passerait ici empoisonnerait #pausedUntil definitivement :
    // Math.max(NaN, x) vaut NaN, et plus aucune pause ne serait jamais honoree.
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return;
    }
    // Le serveur fait autorite : une pause en cours ne peut qu etre allongee.
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + milliseconds);
  }

  /** Jetons actuellement disponibles, arrondi au plancher. Pour les tests et le debug. */
  get availableTokens(): number {
    this.#refill(this.#now());
    return Math.floor(this.#tokens);
  }

  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    try {
      while (this.#waiting.length > 0) {
        const wait = this.#millisecondsUntilAvailable();
        if (wait > 0) {
          // Un Retry-After demesure demanderait un sommeil hors de portee des
          // timers : tronque, la boucle reevalue et rendort autant de fois que
          // necessaire au lieu de tourner a vide toutes les millisecondes.
          await this.#sleep(Math.min(wait, MAX_TIMER_DELAY));
          // Re-evaluation complete au reveil : un pauseFor a pu tomber pendant
          // le sommeil et repousser l echeance de tout le monde.
          continue;
        }
        this.#tokens -= 1;
        this.#waiting.shift()?.resolve();
      }
    } catch (cause) {
      // Sans cette reprise, l echec remonterait dans le void #drain() de
      // acquire, donc en rejet non gere qui tue le processus, en laissant au
      // passage chaque appelant en file suspendu pour toujours.
      this.#rejectAllWaiting(cause);
    } finally {
      this.#draining = false;
    }
  }

  #rejectAllWaiting(cause: unknown): void {
    const error = new Error(
      "Limiteur de debit interrompu : l attente entre deux requetes a echoue.",
      { cause },
    );
    for (const waiter of this.#waiting.splice(0)) {
      waiter.reject(error);
    }
  }

  #millisecondsUntilAvailable(): number {
    const now = this.#now();
    const pauseRemaining = this.#pausedUntil - now;
    if (pauseRemaining > 0) {
      return Math.ceil(pauseRemaining);
    }

    this.#refill(now);
    if (this.#tokens >= 1) {
      return 0;
    }

    // L attente est arrondie au milliseconde superieure, mais le rechargement
    // se calcule sur le temps reellement ecoule : l arrondi revient en fraction
    // de jeton au lieu de s accumuler en derive.
    return Math.ceil(((1 - this.#tokens) * MILLISECONDS_PER_SECOND) / this.#requestsPerSecond);
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefillAt;
    // Une horloge qui recule (ajustement NTP) ne doit ni creer ni detruire de
    // jetons, et ne doit pas geler le rechargement suivant.
    this.#lastRefillAt = now;
    if (elapsed <= 0) {
      return;
    }
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + (elapsed * this.#requestsPerSecond) / MILLISECONDS_PER_SECOND,
    );
  }
}
