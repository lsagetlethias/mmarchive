import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Logger, redactSecrets } from "../src/ui/logger.js";
import { ProgressDisplay } from "../src/ui/progress.js";

class MemoryStream extends Writable {
  readonly #chunks: string[] = [];

  constructor() {
    super({ decodeStrings: false });
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (typeof chunk === "string") {
      this.#chunks.push(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      this.#chunks.push(chunk.toString("utf8"));
    }
    callback();
  }

  get text(): string {
    return this.#chunks.join("");
  }

  get lines(): readonly string[] {
    const text = this.text;
    return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  }
}

/** Octet d echappement suivi d une sequence CSI: la signature d une couleur ANSI. */

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/;
/** Traits de casse, coches, croix et autres glyphes decoratifs hors ASCII. */
const DECORATIVE = /[\u2500-\u257F\u2714\u2716\u26A0\u00B7]/;

const TOKEN = "5rk9x2q7m4t8v1n6b3z0c5w2ha";
const CHANNEL_ID = "y7t3q9w1e5r2u8i4o6p0a2s5d1";

function makeLogger(options?: {
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly plain?: boolean;
}): { logger: Logger; out: MemoryStream; err: MemoryStream } {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const logger = new Logger({
    level: options?.level ?? "debug",
    plain: options?.plain ?? true,
    out,
    err,
  });
  return { logger, out, err };
}

function exerciseEveryMethod(logger: Logger): void {
  logger.debug("trace de mise au point");
  logger.info("inventaire en cours");
  logger.section("Selection");
  logger.success("34 canaux retenus");
  logger.warn("canal archive illisible");
  logger.error("403 sur un canal public");
  logger.table(["Canal", "Etat"], [["general", "membre"]]);
  logger.callout("Joins a confirmer", ["tech-archi", "veille"]);
}

describe("Logger, longueurs et secrets du token", () => {
  it("utilise bien des jeux de 26 caracteres pour le token et l identifiant de test", () => {
    expect(TOKEN).toHaveLength(26);
    expect(CHANNEL_ID).toHaveLength(26);
  });
});

describe("Logger en mode plain", () => {
  it("n emet aucun octet d echappement ANSI, quelle que soit la methode appelee", () => {
    const { logger, out, err } = makeLogger({ plain: true });
    exerciseEveryMethod(logger);

    expect(out.text.length).toBeGreaterThan(0);
    expect(err.text.length).toBeGreaterThan(0);
    expect(out.text).not.toMatch(ANSI);
    expect(err.text).not.toMatch(ANSI);
    expect(out.text).not.toContain("\u001B");
    expect(err.text).not.toContain("\u001B");
  });

  it("n emet aucun caractere decoratif hors ASCII", () => {
    const { logger, out, err } = makeLogger({ plain: true });
    exerciseEveryMethod(logger);

    expect(out.text).not.toMatch(DECORATIVE);
    expect(err.text).not.toMatch(DECORATIVE);
  });

  it("encadre le callout avec un cadre ASCII lisible dans un fichier de log", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.callout("Joins", ["tech-archi"]);

    expect(out.lines).toEqual([
      "+------------+",
      "| Joins      |",
      "+------------+",
      "| tech-archi |",
      "+------------+",
    ]);
  });
});

describe("Logger en mode colore", () => {
  it("emet des sequences ANSI quand le mode plain est desactive", () => {
    const { logger, out, err } = makeLogger({ plain: false });
    logger.success("extraction terminee");
    logger.error("echec reseau");

    expect(out.text).toMatch(ANSI);
    expect(err.text).toMatch(ANSI);
  });

  it("colore chaque ligne separement pour ne jamais laisser une sequence ouverte", () => {
    const { logger, err } = makeLogger({ plain: false });
    logger.error("ligne un\nligne deux");

    const lines = err.lines;
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/\u001B\[39m$/);
    }
  });
});

describe("Logger, routage des flux", () => {
  it("ecrit warn et error sur le flux d erreur", () => {
    const { logger, out, err } = makeLogger();
    logger.warn("attention");
    logger.error("echec");

    expect(out.text).toBe("");
    expect(err.text).toContain("attention");
    expect(err.text).toContain("echec");
  });

  it("ecrit debug, info, section, success, table et callout sur le flux standard", () => {
    const { logger, out, err } = makeLogger();
    logger.debug("mise au point");
    logger.info("information");
    logger.section("Titre");
    logger.success("ok");
    logger.table(["A"], [["1"]]);
    logger.callout("Titre", ["ligne"]);

    expect(err.text).toBe("");
    expect(out.text).toContain("mise au point");
    expect(out.text).toContain("information");
    expect(out.text).toContain("Titre");
    expect(out.text).toContain("ligne");
  });
});

describe("Logger, filtrage par niveau", () => {
  it("laisse tout passer au niveau debug", () => {
    const { logger, out, err } = makeLogger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(out.text).toContain("d");
    expect(out.text).toContain("i");
    expect(err.text).toContain("w");
    expect(err.text).toContain("e");
  });

  it("supprime debug au niveau info", () => {
    const { logger, out } = makeLogger({ level: "info" });
    logger.debug("invisible");
    logger.info("visible");

    expect(out.text).not.toContain("invisible");
    expect(out.text).toContain("visible");
  });

  it("supprime info et debug au niveau warn, y compris section, success et table", () => {
    const { logger, out, err } = makeLogger({ level: "warn" });
    logger.debug("invisible");
    logger.info("invisible");
    logger.section("invisible");
    logger.success("invisible");
    logger.table(["invisible"], [["invisible"]]);
    logger.warn("visible");

    expect(out.text).toBe("");
    expect(err.text).toContain("visible");
  });

  it("laisse passer le callout au niveau warn car il annonce des effets de bord", () => {
    const { logger, out } = makeLogger({ level: "warn" });
    logger.callout("Joins", ["tech-archi"]);

    expect(out.text).toContain("tech-archi");
  });

  it("ne laisse plus que error au niveau error", () => {
    const { logger, out, err } = makeLogger({ level: "error" });
    logger.info("invisible");
    logger.warn("invisible");
    logger.callout("invisible", []);
    logger.error("visible");

    expect(out.text).toBe("");
    expect(err.text).toContain("visible");
    expect(err.text).not.toContain("invisible");
  });
});

describe("Logger.table", () => {
  it("aligne les colonnes sur le contenu le plus large, accents compris", () => {
    const { logger, out } = makeLogger({ plain: true });
    // "cafe" suivi d un accent aigu combinant: 5 unites JavaScript, 4 colonnes affichees.
    logger.table(
      ["Canal", "Messages"],
      [
        ["general", "12"],
        ["cafe\u0301", "7"],
      ],
    );

    expect(out.lines).toEqual([
      "Canal    Messages",
      "-".repeat(17),
      "general  12",
      "cafe\u0301     7",
    ]);
  });

  it("fait demarrer la seconde colonne a la meme position visuelle sur toutes les lignes", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.table(
      ["Canal", "Messages"],
      [
        ["general", "12"],
        ["cafe\u0301", "7"],
        ["e\u0301quipe", "3"],
      ],
    );

    const [header, , ...rows] = out.lines;
    expect(header?.normalize("NFC").indexOf("Messages")).toBe(9);
    expect(rows[0]?.normalize("NFC").indexOf("12")).toBe(9);
    expect(rows[1]?.normalize("NFC").indexOf("7")).toBe(9);
    expect(rows[2]?.normalize("NFC").indexOf("3")).toBe(9);
  });

  it("complete les lignes plus courtes que l en tete", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.table(["A", "B", "C"], [["1"]]);

    expect(out.lines).toEqual(["A  B  C", "-".repeat(7), "1"]);
  });

  it("prend en compte les colonnes supplementaires absentes de l en tete", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.table(["A"], [["1", "surnumeraire"]]);

    expect(out.lines).toEqual(["A", "-".repeat(15), "1  surnumeraire"]);
  });

  it("n ecrit rien quand il n y a ni en tete ni ligne", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.table([], []);

    expect(out.text).toBe("");
  });

  it("masque un token qui traine dans une cellule", () => {
    const { logger, out } = makeLogger({ plain: true });
    logger.table(["Canal", "Detail"], [["general", `token=${TOKEN}`]]);

    expect(out.text).not.toContain(TOKEN);
    expect(out.text).toContain("token=***");
  });
});

describe("redactSecrets, secrets explicites", () => {
  it("remplace la valeur exacte d un secret fourni", () => {
    expect(redactSecrets(`la valeur est ${TOKEN}`, [TOKEN])).toBe("la valeur est ***");
  });

  it("remplace toutes les occurrences d un meme secret", () => {
    expect(redactSecrets(`${TOKEN} et ${TOKEN}`, [TOKEN])).toBe("*** et ***");
  });

  it("traite le secret le plus long en premier", () => {
    expect(redactSecrets("abcdef", ["abc", "abcdef"])).toBe("***");
  });

  it("ignore un secret vide au lieu de decouper toute la chaine", () => {
    expect(redactSecrets("chaine intacte", [""])).toBe("chaine intacte");
  });

  it("laisse le texte intact quand aucun secret ne correspond", () => {
    expect(redactSecrets("rien a masquer", ["autre-chose"])).toBe("rien a masquer");
  });

  it("fonctionne sans liste de secrets", () => {
    expect(redactSecrets("rien a masquer")).toBe("rien a masquer");
  });
});

describe("redactSecrets, motifs de token", () => {
  it.each([
    [`Authorization: Bearer ${TOKEN}`, "Authorization: Bearer ***"],
    [`token=${TOKEN}`, "token=***"],
    [`token: ${TOKEN}`, "token: ***"],
    [`MM_TOKEN=${TOKEN}`, "MM_TOKEN=***"],
    [`MM_TOKEN = ${TOKEN}`, "MM_TOKEN = ***"],
    [`{"token":"${TOKEN}"}`, '{"token":"***"}'],
    [`X-MM-TOKEN: ${TOKEN}`, "X-MM-TOKEN: ***"],
    [`bearer ${TOKEN}`, "bearer ***"],
  ])("masque %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("ne masque pas un identifiant de canal isole", () => {
    const text = `Canal ${CHANNEL_ID} extrait`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("ne masque pas un identifiant presente comme un channel_id", () => {
    const text = `channel_id=${CHANNEL_ID}`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("ne masque pas une liste d identifiants a joindre", () => {
    const text = `${CHANNEL_ID} ${CHANNEL_ID} ${CHANNEL_ID}`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("ne masque pas une suite plus longue que 26 caracteres apres un mot cle", () => {
    const text = `token=${TOKEN}zzzz`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("ne masque pas une suite en majuscules, hors du format d un token Mattermost", () => {
    const text = `Bearer ${TOKEN.toUpperCase()}`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("ne se declenche pas sur un mot qui commence par token", () => {
    const text = `tokenizer ${CHANNEL_ID}`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("masque plusieurs tokens dans la meme chaine", () => {
    expect(redactSecrets(`token=${TOKEN} puis Bearer ${TOKEN}`)).toBe("token=*** puis Bearer ***");
  });

  it("combine secrets explicites et motifs contextuels", () => {
    const result = redactSecrets(`Bearer ${TOKEN} pour ${CHANNEL_ID}`, ["pour"]);
    expect(result).toBe(`Bearer *** *** ${CHANNEL_ID}`);
  });
});

describe("Logger, masquage automatique", () => {
  it("masque un token avant de l ecrire sur le flux standard", () => {
    const { logger, out } = makeLogger();
    logger.info(`appel avec token=${TOKEN}`);

    expect(out.text).not.toContain(TOKEN);
    expect(out.text).toContain("token=***");
  });

  it("masque un token avant de l ecrire sur le flux d erreur", () => {
    const { logger, err } = makeLogger();
    logger.error(`401 sur Authorization: Bearer ${TOKEN}`);

    expect(err.text).not.toContain(TOKEN);
  });

  it("masque un token dans un callout", () => {
    const { logger, out } = makeLogger();
    logger.callout("Configuration", [`MM_TOKEN=${TOKEN}`]);

    expect(out.text).not.toContain(TOKEN);
  });

  it("preserve les identifiants de canaux dans un tableau recapitulatif", () => {
    const { logger, out } = makeLogger();
    logger.table(["Id", "Nom"], [[CHANNEL_ID, "tech-archi"]]);

    expect(out.text).toContain(CHANNEL_ID);
  });
});

describe("ProgressDisplay desactive", () => {
  it("n ecrit rien du tout, meme apres un cycle complet", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: false, out });

    const reporter = display.addChannel("c1", "tech-archi");
    reporter.start(100);
    reporter.increment(10);
    reporter.setTotal(200);
    reporter.increment(190);
    reporter.stop();
    display.stop();

    expect(out.text).toBe("");
  });

  it("reste utilisable: aucune methode du rapporteur ne leve", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: false, out });
    const reporter = display.addChannel("c1", "tech-archi");

    expect(() => {
      reporter.increment(1);
      reporter.setTotal(5);
      reporter.stop();
      reporter.stop();
    }).not.toThrow();
  });

  it("supporte un libelle plus long que la largeur reservee", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: false, out });

    expect(() => display.addChannel("c1", "x".repeat(120))).not.toThrow();
    expect(out.text).toBe("");
  });
});

describe("ProgressDisplay.stop", () => {
  it("est idempotent quand l affichage est desactive", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: false, out });
    display.addChannel("c1", "tech-archi").start(10);

    expect(() => {
      display.stop();
      display.stop();
      display.stop();
    }).not.toThrow();
    expect(out.text).toBe("");
  });

  it("est idempotent quand l affichage est actif", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: true, out });
    const reporter = display.addChannel("c1", "tech-archi");
    reporter.start(10);
    reporter.increment(5);

    expect(() => {
      display.stop();
      display.stop();
    }).not.toThrow();
  });

  it("rend inerte tout canal ajoute apres l arret", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: true, out });
    display.stop();

    const reporter = display.addChannel("c1", "tech-archi");
    expect(() => {
      reporter.start(10);
      reporter.increment(1);
      reporter.stop();
    }).not.toThrow();
  });
});

describe("ProgressDisplay.addChannel", () => {
  it("renvoie le meme rapporteur pour un canal deja ajoute", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: true, out });

    expect(display.addChannel("c1", "tech-archi")).toBe(display.addChannel("c1", "autre-nom"));
    display.stop();
  });

  it("renvoie des rapporteurs distincts pour deux canaux", () => {
    const out = new MemoryStream();
    const display = new ProgressDisplay({ enabled: true, out });

    expect(display.addChannel("c1", "tech-archi")).not.toBe(display.addChannel("c2", "veille"));
    display.stop();
  });
});
