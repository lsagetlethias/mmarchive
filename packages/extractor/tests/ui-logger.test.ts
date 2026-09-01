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
}): { logger: Logger; flux: MemoryStream } {
  const flux = new MemoryStream();
  const logger = new Logger({
    level: options?.level ?? "debug",
    plain: options?.plain ?? true,
    stream: flux,
  });
  return { logger, flux };
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
    const { logger, flux } = makeLogger({ plain: true });
    exerciseEveryMethod(logger);

    expect(flux.text.length).toBeGreaterThan(0);
    expect(flux.text.length).toBeGreaterThan(0);
    expect(flux.text).not.toMatch(ANSI);
    expect(flux.text).not.toMatch(ANSI);
    expect(flux.text).not.toContain("\u001B");
    expect(flux.text).not.toContain("\u001B");
  });

  it("n emet aucun caractere decoratif hors ASCII", () => {
    const { logger, flux } = makeLogger({ plain: true });
    exerciseEveryMethod(logger);

    expect(flux.text).not.toMatch(DECORATIVE);
    expect(flux.text).not.toMatch(DECORATIVE);
  });

  it("encadre le callout avec un cadre ASCII lisible dans un fichier de log", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.callout("Joins", ["tech-archi"]);

    expect(flux.lines).toEqual([
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
    const { logger, flux } = makeLogger({ plain: false });
    logger.success("extraction terminee");
    logger.error("echec reseau");

    expect(flux.text).toMatch(ANSI);
    expect(flux.text).toMatch(ANSI);
  });

  it("colore chaque ligne separement pour ne jamais laisser une sequence ouverte", () => {
    const { logger, flux } = makeLogger({ plain: false });
    logger.error("ligne un\nligne deux");

    const lines = flux.lines;
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/\u001B\[39m$/);
    }
  });
});

describe("Logger, routage des flux", () => {
  it("n ecrit rien sur la sortie standard, quelle que soit la methode", () => {
    // La progression et les diagnostics partaient sur stdout, alors que l aide
    // de --verbose et le README les annoncaient sur la sortie d erreur. Un
    // resultat destine a une machine ne passe pas par le logger : il s ecrit
    // avec process.stdout.write, comme verify --json le fait.
    const surStdout: string[] = [];
    const surStderr: string[] = [];
    const capturer = (cible: string[]) =>
      ((chunk: string) => {
        cible.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = capturer(surStdout);
    process.stderr.write = capturer(surStderr);
    try {
      // Sans `stream` : c est le flux par defaut qui est en cause ici.
      exerciseEveryMethod(new Logger({ level: "debug", plain: true }));
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    expect(surStdout).toEqual([]);
    expect(surStderr.join("")).toContain("inventaire en cours");
  });

  it("envoie sur le flux tout ce qu un humain doit lire", () => {
    const { logger, flux } = makeLogger();
    exerciseEveryMethod(logger);

    for (const attendu of [
      "trace de mise au point",
      "inventaire en cours",
      "Selection",
      "34 canaux retenus",
      "canal archive illisible",
      "403 sur un canal public",
      "general",
      "tech-archi",
    ]) {
      expect(flux.text, attendu).toContain(attendu);
    }
  });
});

describe("Logger, filtrage par niveau", () => {
  it("laisse tout passer au niveau debug", () => {
    const { logger, flux } = makeLogger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(flux.text).toContain("d");
    expect(flux.text).toContain("i");
    expect(flux.text).toContain("w");
    expect(flux.text).toContain("e");
  });

  it("supprime debug au niveau info", () => {
    const { logger, flux } = makeLogger({ level: "info" });
    logger.debug("invisible");
    logger.info("visible");

    expect(flux.text).not.toContain("invisible");
    expect(flux.text).toContain("visible");
  });

  it("supprime info et debug au niveau warn, y compris section, success et table", () => {
    const { logger, flux } = makeLogger({ level: "warn" });
    logger.debug("invisible");
    logger.info("invisible");
    logger.section("invisible");
    logger.success("invisible");
    logger.table(["invisible"], [["invisible"]]);
    logger.warn("visible");

    expect(flux.text).not.toContain("invisible");
    expect(flux.text).toContain("visible");
  });

  it("laisse passer le callout au niveau warn car il annonce des effets de bord", () => {
    const { logger, flux } = makeLogger({ level: "warn" });
    logger.callout("Joins", ["tech-archi"]);

    expect(flux.text).toContain("tech-archi");
  });

  it("ne laisse plus que error au niveau error", () => {
    const { logger, flux } = makeLogger({ level: "error" });
    logger.info("invisible");
    logger.warn("invisible");
    logger.callout("invisible", []);
    logger.error("visible");

    expect(flux.text).toContain("visible");
    expect(flux.text).not.toContain("invisible");
  });
});

describe("Logger.table", () => {
  it("aligne les colonnes sur le contenu le plus large, accents compris", () => {
    const { logger, flux } = makeLogger({ plain: true });
    // "cafe" suivi d un accent aigu combinant: 5 unites JavaScript, 4 colonnes affichees.
    logger.table(
      ["Canal", "Messages"],
      [
        ["general", "12"],
        ["cafe\u0301", "7"],
      ],
    );

    expect(flux.lines).toEqual([
      "Canal    Messages",
      "-".repeat(17),
      "general  12",
      "cafe\u0301     7",
    ]);
  });

  it("fait demarrer la seconde colonne a la meme position visuelle sur toutes les lignes", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.table(
      ["Canal", "Messages"],
      [
        ["general", "12"],
        ["cafe\u0301", "7"],
        ["e\u0301quipe", "3"],
      ],
    );

    const [header, , ...rows] = flux.lines;
    expect(header?.normalize("NFC").indexOf("Messages")).toBe(9);
    expect(rows[0]?.normalize("NFC").indexOf("12")).toBe(9);
    expect(rows[1]?.normalize("NFC").indexOf("7")).toBe(9);
    expect(rows[2]?.normalize("NFC").indexOf("3")).toBe(9);
  });

  it("complete les lignes plus courtes que l en tete", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.table(["A", "B", "C"], [["1"]]);

    expect(flux.lines).toEqual(["A  B  C", "-".repeat(7), "1"]);
  });

  it("prend en compte les colonnes supplementaires absentes de l en tete", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.table(["A"], [["1", "surnumeraire"]]);

    expect(flux.lines).toEqual(["A", "-".repeat(15), "1  surnumeraire"]);
  });

  it("n ecrit rien quand il n y a ni en tete ni ligne", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.table([], []);

    expect(flux.text).toBe("");
  });

  it("masque un token qui traine dans une cellule", () => {
    const { logger, flux } = makeLogger({ plain: true });
    logger.table(["Canal", "Detail"], [["general", `token=${TOKEN}`]]);

    expect(flux.text).not.toContain(TOKEN);
    expect(flux.text).toContain("token=***");
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
    const { logger, flux } = makeLogger();
    logger.info(`appel avec token=${TOKEN}`);

    expect(flux.text).not.toContain(TOKEN);
    expect(flux.text).toContain("token=***");
  });

  it("masque un token avant de l ecrire sur le flux d erreur", () => {
    const { logger, flux } = makeLogger();
    logger.error(`401 sur Authorization: Bearer ${TOKEN}`);

    expect(flux.text).not.toContain(TOKEN);
  });

  it("masque un token dans un callout", () => {
    const { logger, flux } = makeLogger();
    logger.callout("Configuration", [`MM_TOKEN=${TOKEN}`]);

    expect(flux.text).not.toContain(TOKEN);
  });

  it("preserve les identifiants de canaux dans un tableau recapitulatif", () => {
    const { logger, flux } = makeLogger();
    logger.table(["Id", "Nom"], [[CHANNEL_ID, "tech-archi"]]);

    expect(flux.text).toContain(CHANNEL_ID);
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
