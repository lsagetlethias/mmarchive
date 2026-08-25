import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeInstanceUrl,
  OptionsError,
  optionsFingerprint,
  parseRunOptions,
  type RawOptions,
  type RunOptions,
  rateLimitNotice,
  resolveConnection,
} from "../src/config/options.js";

const SECRET = "xoxb-token-tres-secret-a-ne-jamais-afficher";
const ENV = { MM_URL: "https://mattermost.example.org", MM_TOKEN: SECRET };
const MB = 1024 * 1024;

function run(raw: RawOptions = {}, env: Record<string, string | undefined> = ENV): RunOptions {
  return parseRunOptions(raw, env);
}

function capture(fn: () => unknown): OptionsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof OptionsError) {
      return error;
    }
    throw error;
  }
  throw new Error("aucune OptionsError levee alors qu une erreur etait attendue");
}

describe("resolveConnection", () => {
  it("prefere les drapeaux explicites aux variables d environnement", () => {
    const connection = resolveConnection(
      { url: "https://autre.example.org", token: "token-du-flag" },
      ENV,
    );
    expect(connection).toEqual({ url: "https://autre.example.org", token: "token-du-flag" });
  });

  it("retombe sur MM_URL et MM_TOKEN quand les drapeaux sont absents", () => {
    expect(resolveConnection({}, ENV)).toEqual({
      url: "https://mattermost.example.org",
      token: SECRET,
    });
  });

  it("traite un drapeau vide ou blanc comme absent et bascule sur l environnement", () => {
    expect(resolveConnection({ url: "   ", token: "" }, ENV)).toEqual({
      url: "https://mattermost.example.org",
      token: SECRET,
    });
  });

  it("retire le slash final de l URL", () => {
    expect(resolveConnection({ url: "https://mm.example.org/" }, ENV).url).toBe(
      "https://mm.example.org",
    );
    expect(resolveConnection({ url: "https://mm.example.org///" }, ENV).url).toBe(
      "https://mm.example.org",
    );
  });

  it("conserve le port et un chemin de sous-repertoire legitime", () => {
    expect(resolveConnection({ url: "http://localhost:8065" }, ENV).url).toBe(
      "http://localhost:8065",
    );
    expect(resolveConnection({ url: "https://intra.example.org/mattermost/" }, ENV).url).toBe(
      "https://intra.example.org/mattermost",
    );
  });

  it("retire un suffixe /api/v4 colle par erreur en fin d URL", () => {
    expect(resolveConnection({ url: "https://mm.example.org/api/v4" }, ENV).url).toBe(
      "https://mm.example.org",
    );
    expect(resolveConnection({ url: "https://mm.example.org/api/v4/" }, ENV).url).toBe(
      "https://mm.example.org",
    );
    expect(resolveConnection({ url: "https://intra.example.org/mm/api/v4" }, ENV).url).toBe(
      "https://intra.example.org/mm",
    );
  });

  it("explique clairement le retrait du suffixe /api/v4", () => {
    const normalized = normalizeInstanceUrl("https://mm.example.org/api/v4");
    expect(normalized.url).toBe("https://mm.example.org");
    expect(normalized.notice).toContain("/api/v4");
    expect(normalized.notice).toContain("https://mm.example.org");
  });

  it("n emet aucun message quand l URL est deja normalisee", () => {
    expect(normalizeInstanceUrl("https://mm.example.org").notice).toBeUndefined();
  });

  it("retire les identifiants embarques dans l URL et le signale", () => {
    const normalized = normalizeInstanceUrl("https://alice:motdepasse@mm.example.org");
    expect(normalized.url).toBe("https://mm.example.org");
    expect(normalized.notice).toBeDefined();
    expect(normalized.notice).not.toContain("motdepasse");
  });

  it("signale a la fois le retrait des identifiants et celui du suffixe /api/v4", () => {
    const normalized = normalizeInstanceUrl("https://alice:motdepasse@mm.example.org/api/v4/");
    expect(normalized.url).toBe("https://mm.example.org");
    expect(normalized.notice).toContain("identifiants");
    expect(normalized.notice).toContain("/api/v4");
    expect(normalized.notice).not.toContain("motdepasse");
    expect(normalized.notice).not.toContain("alice");
  });

  it("ne retient que l origine et le chemin d une URL collee depuis un navigateur", () => {
    expect(normalizeInstanceUrl("https://mm.example.org/?redirect=x#frag").url).toBe(
      "https://mm.example.org",
    );
  });

  it("refuse un schema autre que http ou https", () => {
    const error = capture(() => resolveConnection({ url: "ftp://mm.example.org" }, ENV));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("http");
  });

  it("leve une OptionsError et non un TypeError sur une URL impossible a parser", () => {
    for (const invalid of ["mm.example.org", "https://", "://mm.example.org", "http:"]) {
      const error = capture(() => resolveConnection({ url: invalid }, ENV));
      expect(error).toBeInstanceOf(OptionsError);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("nomme MM_URL quand l URL manque partout", () => {
    const error = capture(() => resolveConnection({}, { MM_TOKEN: SECRET }));
    expect(error.message).toContain("MM_URL");
    expect(error.message).toContain("--url");
  });

  it("nomme MM_TOKEN quand le token manque ou est vide", () => {
    const absent = capture(() => resolveConnection({}, { MM_URL: ENV.MM_URL }));
    expect(absent.message).toContain("MM_TOKEN");
    expect(absent.message).toContain("--token");

    const vide = capture(() =>
      resolveConnection({ token: "   " }, { MM_URL: ENV.MM_URL, MM_TOKEN: "" }),
    );
    expect(vide.message).toContain("MM_TOKEN");
  });
});

describe("confidentialite du token", () => {
  it("n expose jamais le token dans un message d erreur", () => {
    const cas: (() => unknown)[] = [
      () => resolveConnection({ url: "pas-une-url", token: SECRET }, ENV),
      () => resolveConnection({ url: "ftp://mm.example.org", token: SECRET }, ENV),
      () => run({ since: "pas-une-date" }),
      () => run({ since: "2999-01-01" }),
      () => run({ maxFileSize: "0" }),
      () => run({ maxFileSize: "abc" }),
      () => run({ concurrency: "99" }),
      () => run({ rateLimit: "0" }),
    ];
    for (const cas_ of cas) {
      const error = capture(cas_);
      expect(error.message).not.toContain(SECRET);
      expect(error.stack ?? "").not.toContain(SECRET);
    }
  });

  it("n expose jamais le token dans l empreinte d options", () => {
    const fingerprint = optionsFingerprint(run());
    expect(fingerprint).not.toContain(SECRET);
    expect(/^[0-9a-f]{64}$/.test(fingerprint)).toBe(true);
  });

  it("produit la meme empreinte quels que soient l URL et le token", () => {
    const avec = run({ url: "https://a.example.org", token: "token-a" });
    const autre = run({ url: "https://b.example.org", token: "token-b" });
    expect(optionsFingerprint(avec)).toBe(optionsFingerprint(autre));
  });
});

describe("parseRunOptions, valeurs par defaut", () => {
  it("applique les defauts documentes du README", () => {
    const options = run();
    expect(options.out).toBe("./archive");
    expect(options.file).toBeUndefined();
    expect(options.since).toBeUndefined();
    expect(options.yes).toBe(false);
    expect(options.joinTeams).toBe(false);
    expect(options.leaveAfter).toBe(false);
    expect(options.resume).toBe(false);
    expect(options.skipFiles).toBe(false);
    expect(options.includeEmails).toBe(false);
    expect(options.maxFileSizeBytes).toBe(100 * MB);
    expect(options.concurrency).toBe(4);
    expect(options.rateLimit).toBe(8);
  });

  it("expose la connexion resolue et normalisee, pas les valeurs brutes", () => {
    const options = run({ url: "https://mm.example.org/api/v4/", token: "  token-propre  " });
    expect(options.connection).toEqual({ url: "https://mm.example.org", token: "token-propre" });
  });

  it("propage l echec de resolution de la connexion", () => {
    const error = capture(() => run({}, {}));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("MM_URL");
  });

  it("retient le repertoire de sortie fourni et ignore une valeur vide", () => {
    expect(run({ out: "./sauvegarde" }).out).toBe("./sauvegarde");
    expect(run({ out: "  " }).out).toBe("./archive");
  });

  it("normalise un --file vide en absence de fichier de selection", () => {
    expect(run({ file: "channels.yaml" }).file).toBe("channels.yaml");
    expect(run({ file: "" }).file).toBeUndefined();
  });

  it("propage les drapeaux booleens tels quels", () => {
    const options = run({
      yes: true,
      joinTeams: true,
      leaveAfter: true,
      resume: true,
      skipFiles: true,
      includeEmails: true,
    });
    expect(options.yes).toBe(true);
    expect(options.joinTeams).toBe(true);
    expect(options.leaveAfter).toBe(true);
    expect(options.resume).toBe(true);
    expect(options.skipFiles).toBe(true);
    expect(options.includeEmails).toBe(true);
  });
});

describe("--since", () => {
  it("accepte une date seule et renvoie des millisecondes epoch UTC", () => {
    expect(run({ since: "2024-01-15" }).since).toBe(Date.UTC(2024, 0, 15));
  });

  it("accepte un horodatage complet avec Z", () => {
    expect(run({ since: "2024-01-15T10:00:00Z" }).since).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
  });

  it("accepte les millisecondes et un decalage explicite", () => {
    expect(run({ since: "2024-01-15T10:00:00.500Z" }).since).toBe(
      Date.UTC(2024, 0, 15, 10, 0, 0, 500),
    );
    expect(run({ since: "2024-01-15T12:00:00+02:00" }).since).toBe(Date.UTC(2024, 0, 15, 10));
  });

  it("refuse une chaine qui n est pas une date ISO 8601", () => {
    for (const invalide of ["pas-une-date", "15/01/2024", "2024", "hier", ""]) {
      if (invalide === "") {
        expect(run({ since: invalide }).since).toBeUndefined();
        continue;
      }
      const error = capture(() => run({ since: invalide }));
      expect(error).toBeInstanceOf(OptionsError);
      expect(error.message).toContain("--since");
    }
  });

  it("refuse une date qui a la bonne forme mais n existe pas au calendrier", () => {
    // Date.parse ferait glisser 2024-02-31 au 2 mars sans rien signaler.
    for (const impossible of [
      "2024-02-31",
      "2023-02-29",
      "2024-13-01",
      "2024-01-32",
      "2024-00-10",
    ]) {
      const error = capture(() => run({ since: impossible }));
      expect(error).toBeInstanceOf(OptionsError);
      expect(error.message).toContain("--since");
    }
    expect(run({ since: "2024-02-29" }).since).toBe(Date.UTC(2024, 1, 29));
  });

  it("interprete un horodatage sans decalage en UTC quel que soit le fuseau de la machine", () => {
    const fuseauInitial = process.env.TZ;
    try {
      for (const fuseau of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = fuseau;
        expect(run({ since: "2024-01-15T10:00:00" }).since).toBe(Date.UTC(2024, 0, 15, 10));
        expect(run({ since: "2024-01-15 10:00" }).since).toBe(Date.UTC(2024, 0, 15, 10));
        expect(run({ since: "2024-01-15T00:00:00" }).since).toBe(
          run({ since: "2024-01-15" }).since,
        );
      }
    } finally {
      if (fuseauInitial === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = fuseauInitial;
      }
    }
  });

  it("accepte un decalage sans deux-points et un decalage negatif", () => {
    expect(run({ since: "2024-01-15T12:00:00+0200" }).since).toBe(Date.UTC(2024, 0, 15, 10));
    expect(run({ since: "2024-01-15T05:00:00-05:00" }).since).toBe(Date.UTC(2024, 0, 15, 10));
  });

  it("complete une fraction de seconde plus courte que trois chiffres", () => {
    expect(run({ since: "2024-01-15T10:00:00.5Z" }).since).toBe(
      Date.UTC(2024, 0, 15, 10, 0, 0, 500),
    );
  });

  it("refuse une heure, une minute, une seconde ou un decalage hors bornes", () => {
    for (const impossible of [
      "2024-01-15T25:00:00Z",
      "2024-01-15T10:60:00Z",
      "2024-01-15T10:00:60Z",
      "2024-01-15T24:00:01Z",
      "2024-01-15T24:30:00Z",
      "2024-01-15T10:00:00+99:00",
      "2024-01-15T10:00:00+02:99",
    ]) {
      const error = capture(() => run({ since: impossible }));
      expect(error).toBeInstanceOf(OptionsError);
      expect(error.message).toContain("--since");
    }
  });

  it("accepte 24:00:00 comme fin de journee ISO et le ramene au lendemain", () => {
    expect(run({ since: "2024-01-15T24:00:00Z" }).since).toBe(Date.UTC(2024, 0, 16));
  });

  it("refuse une date dans le futur", () => {
    const error = capture(() => run({ since: "2999-01-01" }));
    expect(error.message).toContain("futur");
  });

  it("accepte une date de la seconde precedente", () => {
    const juste_avant = new Date(Date.now() - 1000).toISOString();
    expect(run({ since: juste_avant }).since).toBe(Date.parse(juste_avant));
  });
});

describe("--max-file-size", () => {
  it("convertit les megaoctets en octets", () => {
    expect(run({ maxFileSize: "50" }).maxFileSizeBytes).toBe(50 * MB);
    expect(run({ maxFileSize: "0.5" }).maxFileSizeBytes).toBe(MB / 2);
  });

  it("refuse 0 en orientant vers --skip-files", () => {
    const error = capture(() => run({ maxFileSize: "0" }));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("--skip-files");
  });

  it("refuse une taille negative", () => {
    const error = capture(() => run({ maxFileSize: "-5" }));
    expect(error.message).toContain("--max-file-size");
  });

  it("refuse une taille qui s arrondit a zero octet plutot que de tout ignorer", () => {
    const error = capture(() => run({ maxFileSize: "0.0000001" }));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("--skip-files");
  });

  it("conserve un octet pour la plus petite taille encore representable", () => {
    expect(run({ maxFileSize: "0.000001" }).maxFileSizeBytes).toBe(1);
  });

  it("refuse une taille au-dela de ce qu un compteur d octets represente exactement", () => {
    const error = capture(() => run({ maxFileSize: "999999999999999" }));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("--max-file-size");
    expect(Number.isSafeInteger(run({ maxFileSize: "100" }).maxFileSizeBytes)).toBe(true);
  });

  it("refuse une valeur non numerique en nommant le drapeau", () => {
    const error = capture(() => run({ maxFileSize: "abc" }));
    expect(error.message).toContain("--max-file-size");
    expect(error.message).toContain("abc");
  });
});

describe("--concurrency", () => {
  it("accepte les bornes 1 et 32", () => {
    expect(run({ concurrency: "1" }).concurrency).toBe(1);
    expect(run({ concurrency: "32" }).concurrency).toBe(32);
  });

  it("refuse 0 et au-dela de 32", () => {
    for (const hors_bornes of ["0", "33", "-1", "1000"]) {
      const error = capture(() => run({ concurrency: hors_bornes }));
      expect(error.message).toContain("--concurrency");
    }
  });

  it("refuse une valeur decimale", () => {
    const error = capture(() => run({ concurrency: "4.5" }));
    expect(error.message).toContain("entier");
  });

  it("refuse une valeur non numerique plutot que de produire un NaN silencieux", () => {
    const error = capture(() => run({ concurrency: "abc" }));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("--concurrency");
  });
});

describe("--rate-limit", () => {
  it("accepte un debit fractionnaire et la borne haute", () => {
    expect(run({ rateLimit: "0.5" }).rateLimit).toBe(0.5);
    expect(run({ rateLimit: "100" }).rateLimit).toBe(100);
  });

  it("refuse 0, un debit negatif et un debit au-dela de 100", () => {
    for (const invalide of ["0", "-2", "101"]) {
      const error = capture(() => run({ rateLimit: invalide }));
      expect(error.message).toContain("--rate-limit");
    }
  });

  it("refuse une valeur non numerique en nommant le drapeau", () => {
    const error = capture(() => run({ rateLimit: "abc" }));
    expect(error).toBeInstanceOf(OptionsError);
    expect(error.message).toContain("--rate-limit");
  });

  it("n avertit pas jusqu au defaut serveur de 10 requetes par seconde", () => {
    expect(rateLimitNotice(run().rateLimit)).toBeUndefined();
    expect(rateLimitNotice(10)).toBeUndefined();
  });

  it("avertit au-dela de 10 requetes par seconde en citant le defaut Mattermost", () => {
    const notice = rateLimitNotice(run({ rateLimit: "25" }).rateLimit);
    expect(notice).toContain("10");
    expect(notice).toContain("429");
  });

  it("refuse un nombre trop grand pour rester fini", () => {
    const error = capture(() => run({ rateLimit: "9".repeat(400) }));
    expect(error).toBeInstanceOf(OptionsError);
  });
});

describe("optionsFingerprint", () => {
  it("ignore les options d execution : concurrence, debit, confirmation, sortie", () => {
    const reference = optionsFingerprint(run());
    const variantes: RawOptions[] = [
      { concurrency: "32" },
      { rateLimit: "1" },
      { yes: true },
      { leaveAfter: true },
      { joinTeams: true },
      { resume: true },
      { out: "./ailleurs" },
      { file: "channels.yaml" },
    ];
    for (const variante of variantes) {
      expect(optionsFingerprint(run(variante))).toBe(reference);
    }
  });

  it("prouve que seule la concurrence ne change rien a l empreinte", () => {
    const lent = run({ concurrency: "1", rateLimit: "1" });
    const rapide = run({ concurrency: "16", rateLimit: "9" });
    expect(lent.concurrency).not.toBe(rapide.concurrency);
    expect(optionsFingerprint(lent)).toBe(optionsFingerprint(rapide));
  });

  it("change des qu une option modifie la forme de l archive", () => {
    const reference = optionsFingerprint(run());
    const formes: RawOptions[] = [
      { includeEmails: true },
      { skipFiles: true },
      { maxFileSize: "10" },
      { since: "2024-01-15" },
    ];
    const empreintes = new Set(formes.map((forme) => optionsFingerprint(run(forme))));
    expect(empreintes.size).toBe(formes.length);
    for (const empreinte of empreintes) {
      expect(empreinte).not.toBe(reference);
    }
  });

  it("neutralise la borne de taille quand --skip-files retire toutes les pieces jointes", () => {
    const parDefaut = optionsFingerprint(run({ skipFiles: true }));
    const borneExplicite = optionsFingerprint(run({ skipFiles: true, maxFileSize: "7" }));
    expect(borneExplicite).toBe(parDefaut);
    expect(parDefaut).not.toBe(optionsFingerprint(run()));
  });

  it("distingue deux bornes de taille tant que les pieces jointes sont archivees", () => {
    expect(optionsFingerprint(run({ maxFileSize: "7" }))).not.toBe(
      optionsFingerprint(run({ maxFileSize: "9" })),
    );
  });

  it("distingue deux bornes --since differentes", () => {
    expect(optionsFingerprint(run({ since: "2024-01-15" }))).not.toBe(
      optionsFingerprint(run({ since: "2024-01-16" })),
    );
  });

  it("est independante de l ordre de declaration des cles", () => {
    const connection = { url: "https://mm.example.org", token: SECRET };
    const premier: RunOptions = {
      connection,
      file: undefined,
      out: "./archive",
      yes: false,
      joinTeams: false,
      leaveAfter: false,
      since: 1_705_276_800_000,
      resume: false,
      skipFiles: true,
      maxFileSizeBytes: 100 * MB,
      includeEmails: true,
      concurrency: 4,
      rateLimit: 8,
      postsPageSize: 200,
    };
    const second: RunOptions = {
      rateLimit: 2,
      concurrency: 31,
      postsPageSize: 60,
      includeEmails: true,
      maxFileSizeBytes: 100 * MB,
      skipFiles: true,
      resume: true,
      since: 1_705_276_800_000,
      leaveAfter: true,
      joinTeams: true,
      yes: true,
      out: "./autre",
      file: "channels.yaml",
      connection: { url: "https://autre.example.org", token: "autre-token" },
    };
    expect(optionsFingerprint(premier)).toBe(optionsFingerprint(second));
  });

  it("est stable dans le temps pour une representation canonique connue", () => {
    const attendu = createHash("sha256")
      .update(
        "include_emails=false&max_file_size_bytes=104857600&since=null&skip_files=false",
        "utf8",
      )
      .digest("hex");
    expect(optionsFingerprint(run())).toBe(attendu);
    expect(optionsFingerprint(run())).toBe(optionsFingerprint(run()));

    const attenduSansFichiers = createHash("sha256")
      .update("include_emails=false&max_file_size_bytes=null&since=null&skip_files=true", "utf8")
      .digest("hex");
    expect(optionsFingerprint(run({ skipFiles: true }))).toBe(attenduSansFichiers);
  });
});
