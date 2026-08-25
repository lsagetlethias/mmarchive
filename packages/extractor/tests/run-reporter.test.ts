import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  RunReporter,
  displayWidth,
  formatCount,
  formatDuration,
  truncateToWidth,
} from "../src/ui/run-reporter.js";

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

describe("displayWidth", () => {
  it("compte deux colonnes pour un emoji et un ideogramme", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("🏉")).toBe(2);
    expect(displayWidth("漢字")).toBe(4);
  });

  it("ne compte pas les selecteurs de variation", () => {
    expect(displayWidth("\u2764\uFE0F")).toBe(1);
  });
});

describe("truncateToWidth", () => {
  it("laisse intact ce qui tient dans la largeur", () => {
    expect(truncateToWidth("abcdef", 10)).toBe("abcdef");
  });

  it("tronque et signale la coupe", () => {
    const result = truncateToWidth("abcdefghij", 5);
    expect(displayWidth(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("ne coupe jamais au milieu d un emoji", () => {
    // Couper un caractere multi-octets en deux produirait un octet de
    // remplacement et decalerait la largeur reelle.
    const result = truncateToWidth("🏉🏉🏉🏉", 5);
    expect(displayWidth(result)).toBeLessThanOrEqual(5);
    expect(result).not.toContain("\uFFFD");
  });

  it("respecte la largeur meme avec des caracteres larges", () => {
    for (const width of [3, 8, 15, 40]) {
      const result = truncateToWidth("🏉 CNR - Conseil national de la refondation", width);
      expect(displayWidth(result)).toBeLessThanOrEqual(width);
    }
  });

  it("renvoie une chaine vide sur une largeur nulle", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });
});

describe("RunReporter", () => {
  function make(out: Capture, clock: ReturnType<typeof makeClock>, interactive = false) {
    return new RunReporter({
      estimatedMessages: 1000,
      out,
      now: clock.now,
      interactive,
      intervalMs: 1000,
      width: 200,
    });
  }

  it("annonce la progression en canaux et en messages", () => {
    const out = new Capture();
    const reporter = make(out, makeClock());
    reporter.phase("Canaux", 10);
    reporter.channelFinished(120);
    expect(reporter.statusLine()).toContain("Canaux 1/10");
    expect(plain(reporter.statusLine())).toContain("120 messages");
  });

  it("nomme l etape en cours des le demarrage, avant tout canal", () => {
    // Un run commence par les emojis : sans nommer l etape, l affichage
    // resterait a zero et ressemblerait a un blocage.
    const out = new Capture();
    const reporter = make(out, makeClock());
    expect(reporter.statusLine()).toContain("Preparation");
    reporter.phase("Emojis personnalises");
    reporter.phaseTotalIs(762);
    reporter.phaseProgress(340);
    expect(reporter.statusLine()).toContain("Emojis personnalises 340/762");
    expect(reporter.statusLine()).not.toContain("messages");
  });

  it("remet la progression a zero en changeant d etape", () => {
    const out = new Capture();
    const reporter = make(out, makeClock());
    reporter.phase("Emojis personnalises", 762);
    reporter.phaseProgress(700);
    reporter.phase("Utilisateurs et avatars", 82);
    expect(reporter.statusLine()).toContain("Utilisateurs et avatars 0/82");
  });

  it("affiche une etape sans total quand sa taille est inconnue", () => {
    const out = new Capture();
    const reporter = make(out, makeClock());
    reporter.phase("Finalisation");
    expect(reporter.statusLine()).toContain("Finalisation");
    expect(reporter.statusLine()).not.toContain("/");
  });

  it("estime le temps restant a partir des messages, pas des canaux", () => {
    // Les canaux ont des tailles tres inegales : compter les canaux donnerait
    // un temps restant absurde tant qu un gros canal n est pas termine.
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    reporter.phase("Canaux", 10, { estimate: true });
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
    reporter.phase("Canaux", 10, { estimate: true });
    reporter.channelFinished(500);
    reporter.channelFinished(500);
    expect(reporter.statusLine()).toContain("Canaux 2/10");
    expect(reporter.statusLine()).toContain("reste ~0s");
  });

  it("n affiche pas de temps restant hors de l etape des canaux", () => {
    // Pendant les avatars ou la finalisation, les messages n avancent plus :
    // un temps restant fige serait trompeur.
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    reporter.phase("Canaux", 10, { estimate: true });
    clock.advance(10_000);
    reporter.channelFinished(250);
    expect(reporter.statusLine()).toContain("reste");

    reporter.phase("Utilisateurs et avatars", 82);
    expect(reporter.statusLine()).not.toContain("reste");
    reporter.phase("Finalisation");
    expect(reporter.statusLine()).not.toContain("reste");
  });

  it("ne laisse jamais la ligne interactive depasser la largeur du terminal", () => {
    // Une ligne trop longue passe a la ligne suivante, et l effacement par \r ne
    // nettoie que la derniere ligne physique : les precedentes restent a l ecran
    // et ressemblent a des doublons.
    const out = new Capture();
    const reporter = new RunReporter({
      estimatedMessages: 1000,
      out,
      now: makeClock().now,
      interactive: true,
      intervalMs: 1000,
      width: 40,
    });
    reporter.phase("Canaux", 758, { estimate: true });
    reporter.channelStarted("🏉 CNR - Conseil national de la refondation");
    reporter.channelFinished(100);
    reporter.stop();
    for (const line of out.text.split(ESC + "[2K")) {
      const visible = line.replace(/\r/g, "");
      if (visible.length === 0) continue;
      expect(displayWidth(visible)).toBeLessThanOrEqual(40);
    }
  });

  it("n annonce pas de temps restant sur un echantillon trop faible", () => {
    // Les canaux sont tries par nom, pas par taille : apres cinq petits canaux,
    // l estimation annoncait plus de deux cents heures.
    const out = new Capture();
    const clock = makeClock();
    const reporter = make(out, clock);
    reporter.phase("Canaux", 758, { estimate: true });
    clock.advance(60_000);
    reporter.channelFinished(5);
    expect(reporter.statusLine()).not.toContain("reste");

    reporter.channelFinished(300);
    expect(reporter.statusLine()).toContain("reste");
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
