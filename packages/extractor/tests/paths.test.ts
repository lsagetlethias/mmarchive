import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchivePathError, createArchivePaths, sanitizeFileName } from "../src/archive/paths.js";

const ROOT = "/srv/mmarchive-test";
const CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
const FILE_ID = "0123456789abcdefghijklmnop";
const USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const EMOJI_ID = "zzzzzzzzzzzzzzzzzzzzzzzzzz";

const paths = createArchivePaths(ROOT);

const RESERVED_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE_CHARS = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Toutes les garanties de sanitizeFileName en un seul endroit. Sans ce filet, chaque
 * cas limite n est verifie que par sa propre egalite, et une regression sur une
 * garantie transverse passe entre les mailles.
 */
function expectSafeName(result: string, context: string): void {
  const why = `pour ${context}, resultat ${JSON.stringify(result)}`;
  expect(result, `nom vide ${why}`).not.toBe("");
  expect(result.includes("/") || result.includes("\\"), `separateur ${why}`).toBe(false);
  expect(result === "." || result === "..", `traversee ${why}`).toBe(false);
  expect(Buffer.byteLength(result, "utf8"), `bornage ${why}`).toBeLessThanOrEqual(200);
  expect(result.endsWith("."), `point final ${why}`).toBe(false);
  expect(result.endsWith(" "), `espace final ${why}`).toBe(false);
  expect(CONTROL_CHARS.test(result), `caractere de controle ${why}`).toBe(false);
  expect(INVISIBLE_CHARS.test(result), `caractere invisible ${why}`).toBe(false);

  const firstDot = result.indexOf(".");
  const stem = (firstDot === -1 ? result : result.slice(0, firstDot)).trim().toUpperCase();
  expect(RESERVED_STEMS.has(stem), `nom reserve ${why}`).toBe(false);

  // Verification par le vrai calcul de chemin, pas par inspection de la chaine.
  const relative = paths.relative(join(paths.root, "bac-a-sable", result));
  expect(relative.split("/"), `sortie du repertoire ${why}`).toHaveLength(2);
}

const HOSTILE_NAMES = [
  "",
  " ",
  "   ",
  ".",
  "..",
  "...",
  " . . ",
  "/",
  "\\",
  "//////",
  "../../etc/passwd",
  "..\\..\\windows\\system32\\drivers\\etc\\hosts",
  "/absolu/interdit",
  "photo.png\u0000/../../.ssh/authorized_keys",
  "\u0000\u0007\u001f\u007f",
  "\u0080\u008a\u009f",
  "\u202e",
  "\ufeff\u200b",
  "facture\u202egnp.exe",
  '<>:"|?*',
  "CON",
  "con.txt",
  "COM1",
  "lpt9.tar.gz",
  "aux ",
  "PRN...",
  "NUL.",
  "a".repeat(300),
  "é".repeat(500),
  `${"\u{1f389}".repeat(100)}.png`,
  `${"a".repeat(199)}.${"b".repeat(40)}`,
  `${"a".repeat(199)} ${"b".repeat(40)}`,
  `${" ".repeat(300)}x`,
  `x${".".repeat(300)}`,
  `CON.${"x".repeat(300)}`,
  `${"CON".repeat(100)}.txt`,
  "note.txt",
  "café-日本語-🎉.txt",
];

const HOSTILE_FALLBACKS = [
  "",
  " ",
  "..",
  "...",
  "/",
  "../evil.bin",
  "CON",
  `CON.${"x".repeat(300)}`,
  "\u0000",
  "\u202e",
  "z".repeat(400),
  `${"z".repeat(199)}.${"y".repeat(40)}`,
  `${"z".repeat(199)} ${"y".repeat(40)}`,
  "piece-jointe.bin",
];

describe("sanitizeFileName : garanties transverses", () => {
  it("respecte toutes ses garanties sur un corpus de noms hostiles", () => {
    for (const name of HOSTILE_NAMES) {
      expectSafeName(sanitizeFileName(name), `le nom ${JSON.stringify(name.slice(0, 40))}`);
    }
  });

  it("respecte toutes ses garanties sur chaque croisement nom hostile / repli hostile", () => {
    for (const name of HOSTILE_NAMES) {
      for (const fallback of HOSTILE_FALLBACKS) {
        expectSafeName(
          sanitizeFileName(name, fallback),
          `le nom ${JSON.stringify(name.slice(0, 20))} et le repli ${JSON.stringify(
            fallback.slice(0, 20),
          )}`,
        );
      }
    }
  });

  it("est idempotent : reassainir un nom deja assaini ne le change plus", () => {
    for (const name of HOSTILE_NAMES) {
      const once = sanitizeFileName(name);
      expect(sanitizeFileName(once)).toBe(once);
    }
  });
});

describe("sanitizeFileName", () => {
  it("laisse intact un nom deja sain", () => {
    expect(sanitizeFileName("compte-rendu.pdf")).toBe("compte-rendu.pdf");
  });

  it("neutralise une tentative de traversee POSIX", () => {
    const result = sanitizeFileName("../../etc/passwd");
    expect(result).toBe("....etcpasswd");
    expect(result).not.toContain("/");
  });

  it("neutralise une tentative de traversee Windows", () => {
    const result = sanitizeFileName("..\\..\\windows");
    expect(result).toBe("....windows");
    expect(result).not.toContain("\\");
  });

  it("ramene un chemin absolu a un simple segment", () => {
    expect(sanitizeFileName("/absolu/interdit")).toBe("absoluinterdit");
  });

  it("neutralise une traversee cachee derriere un octet nul", () => {
    expect(sanitizeFileName("photo.png\u0000/../../.ssh/authorized_keys")).toBe(
      `photo.png${".".repeat(5)}sshauthorized_keys`,
    );
  });

  it("retire les caracteres de controle 0x00 a 0x1F et 0x7F", () => {
    expect(sanitizeFileName("rap\u0000\u0007\u001f\u007fport.pdf")).toBe("rapport.pdf");
    expect(sanitizeFileName("saut\nde\tligne.txt")).toBe("sautdeligne.txt");
  });

  it("retire aussi les controles C1, invisibles dans un terminal", () => {
    expect(sanitizeFileName("rap\u0080\u008a\u009fport.pdf")).toBe("rapport.pdf");
  });

  it("retire les marques directionnelles qui masquent la vraie extension", () => {
    // Sans ce retrait, le nom s affiche "factureexe.png" dans un explorateur alors
    // que le fichier sur disque est bien un .exe.
    expect(sanitizeFileName("facture\u202egnp.exe")).toBe("facturegnp.exe");
    expect(sanitizeFileName("\u202dnote\u202c.txt")).toBe("note.txt");
    expect(sanitizeFileName("\u2066a\u2069b.txt")).toBe("ab.txt");
    expect(sanitizeFileName("note\u200e\u200f.txt")).toBe("note.txt");
  });

  it("retire les espaces de largeur nulle et la marque d ordre des octets", () => {
    expect(sanitizeFileName("a\u200bb\ufeffc.txt")).toBe("abc.txt");
    expect(sanitizeFileName("\ufeff\u200b")).toBe("fichier");
  });

  it("retire les caracteres interdits sous Windows", () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe("abcdefgh.txt");
  });

  it("remplace un nom compose uniquement de caracteres interdits par le fallback", () => {
    expect(sanitizeFileName('<>:"|?*/\\')).toBe("fichier");
  });

  it("remplace le point seul et le double point par le fallback", () => {
    expect(sanitizeFileName(".")).toBe("fichier");
    expect(sanitizeFileName("..")).toBe("fichier");
    expect(sanitizeFileName("...")).toBe("fichier");
  });

  it("retourne le fallback pour une chaine vide ou faite d espaces", () => {
    expect(sanitizeFileName("")).toBe("fichier");
    expect(sanitizeFileName("     ")).toBe("fichier");
  });

  it("accepte un fallback personnalise", () => {
    expect(sanitizeFileName("", "piece-jointe.bin")).toBe("piece-jointe.bin");
  });

  it("retombe sur fichier quand le fallback ne laisse rien d exploitable", () => {
    expect(sanitizeFileName("", "..")).toBe("fichier");
    expect(sanitizeFileName("", "")).toBe("fichier");
    expect(sanitizeFileName("", "\u0000\u202e")).toBe("fichier");
  });

  it("assainit un fallback qui contient des separateurs", () => {
    expect(sanitizeFileName("", "../evil.bin")).toBe("..evil.bin");
  });

  it("applique au fallback exactement la meme pipeline qu au nom principal", () => {
    expect(sanitizeFileName("", "CON")).toBe("_CON");
    expect(sanitizeFileName("", "CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("", "nom.  ")).toBe("nom");
    expect(sanitizeFileName("", "a<b>c.txt")).toBe("abc.txt");
  });

  it("borne un fallback demesure a 200 octets", () => {
    const result = sanitizeFileName("", "z".repeat(400));
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
  });

  it("ne laisse pas un fallback tronque se terminer par un point ou un espace", () => {
    // La troncature coupe juste apres le point : sans re-rognage, Windows creerait
    // le fichier sans son point final et le chemin note dans files.ndjson pointerait
    // vers un fichier inexistant.
    const dot = sanitizeFileName("", `${"z".repeat(199)}.${"y".repeat(40)}`);
    expect(dot.endsWith(".")).toBe(false);
    expect(dot).toBe("z".repeat(199));

    const space = sanitizeFileName("", `${"z".repeat(199)} ${"y".repeat(40)}`);
    expect(space.endsWith(" ")).toBe(false);
    expect(space).toBe("z".repeat(199));
  });

  it("borne le fallback avant de verifier qu il n est pas un nom reserve", () => {
    const result = sanitizeFileName("", `CON.${"x".repeat(300)}`);
    expect(result.startsWith("_CON.")).toBe(true);
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
  });

  it("neutralise les noms reserves Windows, avec ou sans extension", () => {
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("nul")).toBe("_nul");
    expect(sanitizeFileName("cOm9.tar.gz")).toBe("_cOm9.tar.gz");
    expect(sanitizeFileName("LPT1.log")).toBe("_LPT1.log");
    expect(sanitizeFileName("aux")).toBe("_aux");
    expect(sanitizeFileName("PRN")).toBe("_PRN");
    expect(sanitizeFileName("aux   ")).toBe("_aux");
    expect(sanitizeFileName("CON...")).toBe("_CON");
  });

  it("laisse passer les noms qui ressemblent a un nom reserve sans en etre un", () => {
    expect(sanitizeFileName("COM0.txt")).toBe("COM0.txt");
    expect(sanitizeFileName("COM10.txt")).toBe("COM10.txt");
    expect(sanitizeFileName("CONSOLE.txt")).toBe("CONSOLE.txt");
    expect(sanitizeFileName("console")).toBe("console");
    expect(sanitizeFileName("_CON.txt")).toBe("_CON.txt");
  });

  it("retire les espaces et les points en fin de nom", () => {
    expect(sanitizeFileName("nom.  ")).toBe("nom");
    expect(sanitizeFileName("nom...")).toBe("nom");
    expect(sanitizeFileName("nom . . ")).toBe("nom");
    expect(sanitizeFileName("rapport.pdf ")).toBe("rapport.pdf");
  });

  it("borne la longueur a 200 octets et non a 200 caracteres", () => {
    const result = sanitizeFileName("é".repeat(500));
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
    expect(result.length).toBe(100);
    expect(result).toBe("é".repeat(100));
  });

  it("preserve l extension quand il faut tronquer", () => {
    const result = sanitizeFileName(`${"é".repeat(500)}.pdf`);
    expect(result.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
  });

  it("ne coupe jamais au milieu d un caractere multi-octets", () => {
    const result = sanitizeFileName(`${"🎉".repeat(100)}.png`);
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
    expect(result).toBe(`${"🎉".repeat(49)}.png`);
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("n essaie pas de preserver une pseudo-extension demesuree", () => {
    const result = sanitizeFileName(`${"a".repeat(199)}.${"c".repeat(300)}`);
    expect(result).toBe("a".repeat(199));
  });

  it("retourne le fallback si la troncature ne laisse que des espaces", () => {
    expect(sanitizeFileName(`${" ".repeat(300)}x`)).toBe("fichier");
  });

  it("borne aussi le nom une fois le prefixe de neutralisation ajoute", () => {
    const result = sanitizeFileName(`CON.${"x".repeat(300)}`);
    expect(Buffer.byteLength(result, "utf8")).toBe(200);
    expect(result.startsWith("_CON.")).toBe(true);
  });

  it("preserve les accents, les ideogrammes et les emojis", () => {
    expect(sanitizeFileName("café-日本語-🎉.txt")).toBe("café-日本語-🎉.txt");
    expect(sanitizeFileName("Übergrößenträger.md")).toBe("Übergrößenträger.md");
  });

  it("conserve un fichier cache, qui n est pas une traversee", () => {
    expect(sanitizeFileName(".gitignore")).toBe(".gitignore");
    expect(sanitizeFileName("..a")).toBe("..a");
  });
});

describe("createArchivePaths", () => {
  it("resout une racine relative en chemin absolu", () => {
    const relativeRoot = createArchivePaths("archive-locale");
    expect(isAbsolute(relativeRoot.root)).toBe(true);
    expect(relativeRoot.root).toBe(resolve("archive-locale"));
  });

  it("refuse une racine vide ou faite d espaces", () => {
    // resolve("") vaut le repertoire courant : une racine vide ecrirait l archive
    // la ou la CLI a ete lancee sans que personne ne l ait demande.
    expect(() => createArchivePaths("")).toThrow(ArchivePathError);
    expect(() => createArchivePaths("   ")).toThrow(ArchivePathError);
    expect(() => createArchivePaths("\t\n")).toThrow(ArchivePathError);
  });

  it("normalise un separateur final et un segment redondant dans la racine", () => {
    expect(createArchivePaths(`${ROOT}/`).root).toBe(paths.root);
    expect(createArchivePaths(`${ROOT}/sous/..`).root).toBe(paths.root);
  });

  it("isole deux instances : chacune garde sa propre racine", () => {
    const other = createArchivePaths("/srv/autre-archive");
    expect(other.root).not.toBe(paths.root);
    expect(other.manifest).toBe(join("/srv/autre-archive", "manifest.json"));
    expect(paths.manifest).toBe(join(ROOT, "manifest.json"));
    expect(() => other.relative(paths.manifest)).toThrow(ArchivePathError);
  });

  it("expose les fichiers racine du format d archive", () => {
    expect(paths.relative(paths.manifest)).toBe("manifest.json");
    expect(paths.relative(paths.users)).toBe("users.ndjson");
    expect(paths.relative(paths.teams)).toBe("teams.ndjson");
    expect(paths.relative(paths.channels)).toBe("channels.ndjson");
    expect(paths.relative(paths.emojis)).toBe("emojis.ndjson");
    expect(paths.relative(paths.files)).toBe("files.ndjson");
    expect(paths.relative(paths.state)).toBe(".extract-state.json");
  });

  it("place le fichier de posts d un canal dans posts/", () => {
    expect(paths.postsFile(CHANNEL_ID)).toBe(join(ROOT, "posts", `${CHANNEL_ID}.ndjson`));
    expect(paths.relative(paths.postsFile(CHANNEL_ID))).toBe(`posts/${CHANNEL_ID}.ndjson`);
  });

  it("place le fichier de travail a cote du fichier final, sans le confondre avec lui", () => {
    expect(paths.relative(paths.postsPartFile(CHANNEL_ID))).toBe(`posts/${CHANNEL_ID}.ndjson.part`);
    expect(paths.postsPartFile(CHANNEL_ID).startsWith(paths.postsFile(CHANNEL_ID))).toBe(true);
    expect(paths.postsPartFile(CHANNEL_ID)).not.toBe(paths.postsFile(CHANNEL_ID));
    // Meme repertoire : le remplacement final doit rester un rename atomique.
    expect(paths.relative(paths.postsPartFile(CHANNEL_ID)).split("/").slice(0, -1)).toEqual([
      "posts",
    ]);
  });

  it("suit le schema attachments/<file_id>/<nom assaini>", () => {
    expect(paths.relative(paths.attachmentFile(FILE_ID, "compte-rendu.pdf"))).toBe(
      `attachments/${FILE_ID}/compte-rendu.pdf`,
    );
  });

  it("assainit le nom d une piece jointe qui tente une traversee", () => {
    const relative = paths.relative(paths.attachmentFile(FILE_ID, "../../.ssh/authorized_keys"));
    expect(relative.split("/")).toHaveLength(3);
    expect(relative).toBe(`attachments/${FILE_ID}/${".".repeat(5)}sshauthorized_keys`);
  });

  it("garde toute piece jointe hostile dans le repertoire de son file_id", () => {
    for (const name of HOSTILE_NAMES) {
      const relative = paths.relative(paths.attachmentFile(FILE_ID, name));
      const segments = relative.split("/");
      expect(segments, `nom ${JSON.stringify(name.slice(0, 30))}`).toHaveLength(3);
      expect(segments[0]).toBe("attachments");
      expect(segments[1]).toBe(FILE_ID);
    }
  });

  it("retombe sur le nom par defaut pour une piece jointe sans nom exploitable", () => {
    expect(paths.relative(paths.attachmentFile(FILE_ID, ".."))).toBe(
      `attachments/${FILE_ID}/fichier`,
    );
  });

  it("place avatars et emojis dans leurs repertoires respectifs", () => {
    expect(paths.relative(paths.avatarFile(USER_ID))).toBe(`avatars/${USER_ID}.png`);
    expect(paths.relative(paths.emojiFile(EMOJI_ID))).toBe(`emoji/${EMOJI_ID}.png`);
  });

  it("refuse un identifiant de canal invalide", () => {
    expect(() => paths.postsFile("../../etc")).toThrow(ArchivePathError);
    expect(() => paths.postsFile("")).toThrow(ArchivePathError);
    expect(() => paths.postsFile("trop-court")).toThrow(ArchivePathError);
    expect(() => paths.postsFile("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toThrow(ArchivePathError);
    expect(() => paths.postsFile(`${CHANNEL_ID}x`)).toThrow(ArchivePathError);
    expect(() => paths.postsFile(CHANNEL_ID.slice(0, 25))).toThrow(ArchivePathError);
    expect(() => paths.postsFile(`${CHANNEL_ID.slice(0, 25)}/`)).toThrow(ArchivePathError);
    expect(() => paths.postsFile(`${CHANNEL_ID.slice(0, 25)}\u0000`)).toThrow(ArchivePathError);
    expect(() => paths.postsFile(`${CHANNEL_ID.slice(0, 25)}\n`)).toThrow(ArchivePathError);
    expect(() => paths.postsFile(`${CHANNEL_ID.slice(0, 25)}_`)).toThrow(ArchivePathError);
  });

  it("refuse un identifiant invalide sur chaque accesseur", () => {
    expect(() => paths.postsPartFile("nope")).toThrow(ArchivePathError);
    expect(() => paths.attachmentFile("nope", "a.txt")).toThrow(ArchivePathError);
    expect(() => paths.avatarFile("nope")).toThrow(ArchivePathError);
    expect(() => paths.emojiFile("nope")).toThrow(ArchivePathError);
  });

  it("expose une classe d erreur identifiable, pas une Error anonyme", () => {
    const error = new ArchivePathError("test");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ArchivePathError");
    try {
      paths.avatarFile("nope");
      expect.unreachable();
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ArchivePathError);
      expect((thrown as Error).name).toBe("ArchivePathError");
    }
  });

  it("donne un message d erreur exploitable et tronque un identifiant demesure", () => {
    expect(() => paths.avatarFile("x".repeat(500))).toThrow(/Identifiant d utilisateur invalide/);
    try {
      paths.avatarFile("y".repeat(500));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArchivePathError);
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });

  it("echappe un identifiant hostile dans le message d erreur", () => {
    try {
      paths.emojiFile("saut\nde\u0000ligne");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("\n");
      expect(message).not.toContain("\u0000");
      expect(message).toContain("\\n");
    }
  });

  it("rend des chemins relatifs a separateurs POSIX", () => {
    const relative = paths.relative(paths.attachmentFile(FILE_ID, "note.txt"));
    expect(relative).not.toContain("\\");
    expect(relative.startsWith("/")).toBe(false);
  });

  it("normalise un chemin qui remonte puis redescend dans la racine", () => {
    expect(paths.relative(join(ROOT, "posts", "..", "manifest.json"))).toBe("manifest.json");
    expect(paths.relative(join(ROOT, ".", "posts", ".", `${CHANNEL_ID}.ndjson`))).toBe(
      `posts/${CHANNEL_ID}.ndjson`,
    );
  });

  it("accepte tout chemin produit par ses propres accesseurs", () => {
    const produced = [
      paths.manifest,
      paths.users,
      paths.teams,
      paths.channels,
      paths.emojis,
      paths.files,
      paths.state,
      paths.postsFile(CHANNEL_ID),
      paths.postsPartFile(CHANNEL_ID),
      paths.attachmentFile(FILE_ID, "note.txt"),
      paths.avatarFile(USER_ID),
      paths.emojiFile(EMOJI_ID),
    ];
    for (const absolutePath of produced) {
      const relative = paths.relative(absolutePath);
      expect(relative).not.toBe("");
      expect(relative.startsWith("..")).toBe(false);
      expect(isAbsolute(relative)).toBe(false);
      expect(join(paths.root, relative)).toBe(absolutePath);
    }
  });

  it("refuse un chemin en dehors de la racine", () => {
    expect(() => paths.relative("/etc/passwd")).toThrow(ArchivePathError);
    expect(() => paths.relative(join(ROOT, "..", "voisin", "x.txt"))).toThrow(ArchivePathError);
    expect(() => paths.relative(join(ROOT, "posts", "..", "..", "x.txt"))).toThrow(
      ArchivePathError,
    );
  });

  it("refuse un repertoire voisin dont le nom prefixe celui de la racine", () => {
    expect(() => paths.relative(`${ROOT}-evil/x.txt`)).toThrow(ArchivePathError);
    expect(() => paths.relative(`${ROOT}evil`)).toThrow(ArchivePathError);
  });

  it("refuse la racine elle-meme, qui ne designe aucun element de l archive", () => {
    expect(() => paths.relative(ROOT)).toThrow(ArchivePathError);
    expect(() => paths.relative(`${ROOT}/`)).toThrow(ArchivePathError);
    expect(() => paths.relative(`${ROOT}/posts/..`)).toThrow(ArchivePathError);
  });

  it("refuse un chemin relatif, resolu hors de la racine depuis le repertoire courant", () => {
    expect(() => paths.relative("manifest.json")).toThrow(ArchivePathError);
  });
});
