import { describe, expect, it } from "vitest";

import { TokenBucketRateLimiter } from "../src/mattermost/rate-limiter.js";

interface PendingTimer {
  readonly at: number;
  readonly resolve: () => void;
}

/**
 * Horloge virtuelle : aucun vrai timer, aucun vrai sommeil. Le temps n avance
 * que sur demande, ce qui rend les assertions de duree exactes au milliseconde.
 */
function createVirtualClock(start = 0) {
  let currentTime = start;
  let timers: PendingTimer[] = [];

  const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 32; index += 1) {
      await Promise.resolve();
    }
  };

  const advanceTo = async (target: number): Promise<void> => {
    await flushMicrotasks();
    for (;;) {
      const due = timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) {
        break;
      }
      timers = timers.filter((timer) => timer !== due);
      currentTime = Math.max(currentTime, due.at);
      due.resolve();
      await flushMicrotasks();
    }
    currentTime = Math.max(currentTime, target);
    await flushMicrotasks();
  };

  return {
    now: (): number => currentTime,
    sleep: (milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => {
        timers.push({ at: currentTime + milliseconds, resolve });
      }),
    advance: (milliseconds: number): Promise<void> => advanceTo(currentTime + milliseconds),
    advanceTo,
    get time(): number {
      return currentTime;
    },
    get pendingTimers(): number {
      return timers.length;
    },
  };
}

type VirtualClock = ReturnType<typeof createVirtualClock>;

interface Tracked {
  settled: boolean;
  at: number;
}

function track(clock: VirtualClock, promise: Promise<void>): Tracked {
  const state: Tracked = { settled: false, at: -1 };
  void promise.then(() => {
    state.settled = true;
    state.at = clock.time;
  });
  return state;
}

describe("TokenBucketRateLimiter", () => {
  it("sert la rafale initiale sans aucune attente puis impose le debit permanent", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      now: clock.now,
      sleep: clock.sleep,
    });

    const burstTimes: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      await limiter.acquire();
      burstTimes.push(clock.time);
    }

    expect(burstTimes).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(limiter.availableTokens).toBe(0);
    expect(clock.pendingTimers).toBe(0);

    const ninth = track(clock, limiter.acquire());
    await clock.advance(124);
    expect(ninth.settled).toBe(false);

    await clock.advance(1);
    expect(ninth.settled).toBe(true);
    expect(ninth.at).toBe(125);

    const tenth = track(clock, limiter.acquire());
    await clock.advance(125);
    expect(tenth.at).toBe(250);
  });

  it("sert vingt acquisitions concurrentes en ordre FIFO au debit annonce", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 8,
      now: clock.now,
      sleep: clock.sleep,
    });

    const servedOrder: number[] = [];
    const servedAt: number[] = [];
    const acquisitions = Array.from({ length: 20 }, (_unused, index) =>
      limiter.acquire().then(() => {
        servedOrder.push(index);
        servedAt.push(clock.time);
      }),
    );

    await clock.advance(0);
    expect(servedOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await clock.advance(1500);
    await Promise.all(acquisitions);

    expect(servedOrder).toEqual(Array.from({ length: 20 }, (_unused, index) => index));
    expect(servedAt.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(servedAt.slice(8)).toEqual([
      125, 250, 375, 500, 625, 750, 875, 1000, 1125, 1250, 1375, 1500,
    ]);
    expect(clock.time).toBe(1500);
    expect(clock.pendingTimers).toBe(0);
  });

  it("sert dans l ordre d arrivee les appelants qui rejoignent une file deja formee", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 4,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: string[] = [];
    void limiter.acquire().then(() => order.push("a"));
    void limiter.acquire().then(() => order.push("b"));
    await clock.advance(10);
    void limiter.acquire().then(() => order.push("c"));

    await clock.advance(1000);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("prolonge une attente deja en cours quand pauseFor tombe pendant le sommeil", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    const waiter = track(clock, limiter.acquire());

    await clock.advance(50);
    limiter.pauseFor(1000);

    await clock.advance(75);
    expect(clock.time).toBe(125);
    expect(waiter.settled).toBe(false);

    await clock.advance(924);
    expect(waiter.settled).toBe(false);

    await clock.advance(1);
    expect(waiter.settled).toBe(true);
    expect(waiter.at).toBe(1050);
    expect(clock.pendingTimers).toBe(0);
  });

  it("ignore un second pauseFor plus court que la pause deja en cours", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    const waiter = track(clock, limiter.acquire());

    limiter.pauseFor(1000);
    await clock.advance(10);
    limiter.pauseFor(100);

    await clock.advanceTo(999);
    expect(waiter.settled).toBe(false);

    await clock.advanceTo(1000);
    expect(waiter.settled).toBe(true);
    expect(waiter.at).toBe(1000);
  });

  it("allonge la pause quand le second pauseFor depasse le premier", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    const waiter = track(clock, limiter.acquire());

    limiter.pauseFor(200);
    await clock.advance(50);
    limiter.pauseFor(500);

    await clock.advanceTo(549);
    expect(waiter.settled).toBe(false);

    await clock.advanceTo(550);
    expect(waiter.settled).toBe(true);
    expect(waiter.at).toBe(550);
  });

  it("traite un pauseFor nul ou negatif comme une absence de pause", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    limiter.pauseFor(0);
    limiter.pauseFor(-5000);
    limiter.pauseFor(Number.NaN);

    const first = track(clock, limiter.acquire());
    await clock.advance(0);
    expect(first.settled).toBe(true);
    expect(first.at).toBe(0);
  });

  it("plafonne les jetons au burst apres une longue inactivite", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 3,
      now: clock.now,
      sleep: clock.sleep,
    });

    await clock.advance(600_000);
    expect(limiter.availableTokens).toBe(3);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.availableTokens).toBe(0);

    const fourth = track(clock, limiter.acquire());
    await clock.advance(124);
    expect(fourth.settled).toBe(false);
    await clock.advance(1);
    expect(fourth.settled).toBe(true);
  });

  it("arrondit availableTokens au plancher sans consommer de jeton", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 8,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    expect(limiter.availableTokens).toBe(7);

    await clock.advance(62);
    expect(limiter.availableTokens).toBe(7);
    expect(limiter.availableTokens).toBe(7);

    await clock.advance(63);
    expect(limiter.availableTokens).toBe(8);
  });

  it("n arme aucun timer tant que personne n attend et n en laisse aucun apres drainage", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(clock.pendingTimers).toBe(0);

    const queued = [limiter.acquire(), limiter.acquire(), limiter.acquire()];
    expect(clock.pendingTimers).toBe(1);

    await clock.advance(1000);
    await Promise.all(queued);
    expect(clock.pendingTimers).toBe(0);
  });

  it("ne derive pas sur une longue serie d acquisitions", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    const times: number[] = [];
    const acquisitions = Array.from({ length: 401 }, () =>
      limiter.acquire().then(() => {
        times.push(clock.time);
      }),
    );

    await clock.advance(60_000);
    await Promise.all(acquisitions);

    expect(times).toHaveLength(401);
    expect(times[0]).toBe(0);
    expect(times[400]).toBe(50_000);
    for (let index = 1; index < times.length; index += 1) {
      expect((times[index] ?? -1) - (times[index - 1] ?? -1)).toBe(125);
    }
  });

  it("ne cree ni ne perd de jetons quand l horloge recule", async () => {
    let currentTime = 10_000;
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 8,
      now: () => currentTime,
      sleep: () => Promise.resolve(),
    });

    await limiter.acquire();
    expect(limiter.availableTokens).toBe(7);

    currentTime = 0;
    expect(limiter.availableTokens).toBe(7);

    currentTime = 1000;
    expect(limiter.availableTokens).toBe(8);
  });

  it("rejette une construction dont le debit ou le burst est invalide", () => {
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 0 })).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: -1 })).toThrow(
      /requestsPerSecond/,
    );
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: Number.NaN })).toThrow(RangeError);
    expect(
      () => new TokenBucketRateLimiter({ requestsPerSecond: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 8, burst: 0 })).toThrow(/burst/);
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 8, burst: -3 })).toThrow(
      RangeError,
    );
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 8, burst: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 8, burst: 1 })).not.toThrow();
  });

  it("accepte un debit inferieur a une requete par seconde", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 0.5,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.availableTokens).toBe(1);
    await limiter.acquire();

    const second = track(clock, limiter.acquire());
    await clock.advance(1999);
    expect(second.settled).toBe(false);
    await clock.advance(1);
    expect(second.settled).toBe(true);
    expect(second.at).toBe(2000);
  });

  it("range un arrivant tardif derriere la file meme si un jeton se libere au meme instant", async () => {
    const clock = createVirtualClock();
    const order: string[] = [];
    const servedAt = new Map<string, number>();
    let onWake: (() => void) | undefined;

    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      // Le reveil du drain et l arrivee du retardataire tombent dans le meme
      // tick : c est l unique fenetre ou un jeton est libre alors que des
      // appelants attendent deja, donc la seule qui exerce le garde-file.
      sleep: async (milliseconds: number): Promise<void> => {
        await clock.sleep(milliseconds);
        const hook = onWake;
        onWake = undefined;
        hook?.();
      },
    });

    const record = (name: string) => (): void => {
      order.push(name);
      servedAt.set(name, clock.time);
    };

    void limiter.acquire().then(record("a"));
    void limiter.acquire().then(record("b"));
    onWake = (): void => {
      void limiter.acquire().then(record("c"));
    };

    await clock.advance(1000);

    expect(order).toEqual(["a", "b", "c"]);
    expect(servedAt.get("b")).toBe(125);
    expect(servedAt.get("c")).toBe(250);
    expect(clock.pendingTimers).toBe(0);
  });

  it("ne se laisse pas empoisonner par un pauseFor NaN ou infini", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    limiter.pauseFor(Number.NaN);
    limiter.pauseFor(Number.POSITIVE_INFINITY);
    limiter.pauseFor(Number.NEGATIVE_INFINITY);

    const immediate = track(clock, limiter.acquire());
    await clock.advance(0);
    expect(immediate.settled).toBe(true);
    expect(immediate.at).toBe(0);

    limiter.pauseFor(1000);
    const paused = track(clock, limiter.acquire());
    await clock.advanceTo(999);
    expect(paused.settled).toBe(false);

    await clock.advanceTo(1000);
    expect(paused.settled).toBe(true);
    expect(paused.at).toBe(1000);
  });

  it("suspend meme un seau plein sans pour autant le vider", async () => {
    const clock = createVirtualClock();
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 4,
      now: clock.now,
      sleep: clock.sleep,
    });

    limiter.pauseFor(500);
    expect(limiter.availableTokens).toBe(4);

    const waiter = track(clock, limiter.acquire());
    await clock.advanceTo(499);
    expect(waiter.settled).toBe(false);

    await clock.advanceTo(500);
    expect(waiter.settled).toBe(true);
    expect(waiter.at).toBe(500);
    expect(limiter.availableTokens).toBe(3);
    expect(clock.pendingTimers).toBe(0);
  });

  it("decoupe une pause hors de portee des timers 32 bits au lieu de tourner a vide", async () => {
    const clock = createVirtualClock();
    const requested: number[] = [];
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: clock.now,
      sleep: (milliseconds: number): Promise<void> => {
        requested.push(milliseconds);
        return clock.sleep(milliseconds);
      },
    });

    limiter.pauseFor(5_000_000_000);
    const waiter = track(clock, limiter.acquire());

    await clock.advanceTo(4_999_999_999);
    expect(waiter.settled).toBe(false);

    await clock.advanceTo(5_000_000_000);
    expect(waiter.settled).toBe(true);
    expect(waiter.at).toBe(5_000_000_000);
    expect(requested).toEqual([2_147_483_647, 2_147_483_647, 705_032_706]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("propage l echec du sommeil a toute la file au lieu de la suspendre pour toujours", async () => {
    let currentTime = 0;
    let broken = true;
    const sleepError = new Error("timer indisponible");
    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 8,
      burst: 1,
      now: () => currentTime,
      sleep: (milliseconds: number): Promise<void> => {
        currentTime += milliseconds;
        return broken ? Promise.reject(sleepError) : Promise.resolve();
      },
    });

    await limiter.acquire();

    const firstOutcome = limiter.acquire().catch((error: unknown) => error);
    const secondOutcome = limiter.acquire().catch((error: unknown) => error);
    const [firstError, secondError] = await Promise.all([firstOutcome, secondOutcome]);

    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBe(firstError);
    expect(firstError instanceof Error ? firstError.message : "").toMatch(
      /Limiteur de debit interrompu/,
    );
    expect(firstError instanceof Error ? firstError.cause : undefined).toBe(sleepError);

    broken = false;
    await expect(limiter.acquire()).resolves.toBeUndefined();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});
