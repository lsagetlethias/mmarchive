import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RunReporter, formatCount, formatDuration } from "../src/ui/run-reporter.js";

const ESC = "\u001B";

class Capture extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  get text(): string {
    return this.chunks.join("");
  }
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** Les separateurs de milliers de toLocaleString sont des espaces insecables. */
function plain(text: string): string {
  return text.replace(/[\u202F\u00A0]/g, " ");
}

describe("formatDuration", () => {
  it("rend les secondes, les minutes et les heures", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(95_000)).toBe("01:35");
    expect(formatDuration(11_400_000)).toBe("3h10");
  });

  it("ne pretend pas connaitre une duree invalide", () => {
    expect(formatDuration(Number.NaN)).toBe("inconnu");
    expect(formatDuration(-1)).toBe("inconnu");
  });
});

describe("formatCount", () => {
  it("groupe les milliers pour rester lisible a grande echelle", () => {
    expect(plain(formatCount(1871542))).toBe("1 871 542");
  });
});

describe("RunReporter", () => {
  function make(out: Capture, clock: ReturnType<typeof makeClock>, interactive = false) {
    return new RunReporter({
      totalChannels: 10,
      estimatedMessages: 1000,
      out,
      now: clock.now,
      interactive,
      intervalMs: 1000,
    });
  }

  it("annonce la progression en canaux et en messages", () => {
    const out = new Capture();
    const reporter = make(out, makeClock());
    reporter.channelFinished(120);
    expect(reporter.statusLine()).toContain("1/10 canaux");
    expect(plain(reporter.statusLine())).toContain("120 messages");
  });

  it("estime le temps restant a partir des messages, pas des canaux", () => {
    // Les canaux ont des tailles tres inegales : compter les canaux donnerait
    // un temps restant absurde tant qu un gros canal n est pas termine.
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    clock.advance(10_000);
    reporter.channelFinished(250);
    // 250 messages en 10 s, il en reste 750 : environ 30 s.
    expect(reporter.statusLine()).toContain("reste ~30s");
  });

  it("ne pretend pas estimer avant d avoir le moindre message", () => {
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    clock.advance(5_000);
    expect(reporter.statusLine()).not.toContain("reste");
  });

  it("affiche le debit reel des que des requetes sont connues", () => {
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    clock.advance(10_000);
    reporter.setRequestCount(80);
    expect(reporter.statusLine()).toContain("8.0 req/s");
  });

  it("n emet aucun code d echappement hors TTY", () => {
    // Un run redirige vers un fichier de log doit rester lisible.
    const out = new Capture();
    const reporter = make(out, makeClock(), false);
    reporter.start();
    reporter.channelFinished(10);
    reporter.note("un evenement");
    reporter.stop();
    expect(out.text).not.toContain(ESC);
    expect(out.text).toContain("un evenement");
  });

  it("reecrit la meme ligne en mode interactif", () => {
    const out = new Capture();
    const reporter = make(out, makeClock(), true);
    reporter.start();
    reporter.channelFinished(10);
    reporter.stop();
    expect(out.text).toContain(`${ESC}[2K`);
  });

  it("laisse les messages ponctuels lisibles au milieu du statut", () => {
    const out = new Capture();
    const reporter = make(out, makeClock(), true);
    reporter.start();
    reporter.note("[erreur] canal x : 500");
    reporter.stop();
    expect(out.text).toContain("[erreur] canal x : 500\n");
  });

  it("compte un canal deja termine sans le reextraire", () => {
    const out = new Capture();
    const reporter = make(out, makeClock());
    reporter.channelFinished(500);
    reporter.channelFinished(500);
    expect(reporter.statusLine()).toContain("2/10 canaux");
    expect(reporter.statusLine()).toContain("reste ~0s");
  });

  it("stop() est idempotent", () => {
    const out = new Capture();
    const reporter = make(out, makeClock(), true);
    reporter.start();
    reporter.stop();
    expect(() => {
      reporter.stop();
    }).not.toThrow();
  });
});
