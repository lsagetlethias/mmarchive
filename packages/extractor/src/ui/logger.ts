import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Desactive couleurs et caracteres decoratifs. Defaut: !process.stdout.isTTY. */
  readonly plain?: boolean;
  readonly out?: NodeJS.WritableStream;
  readonly err?: NodeJS.WritableStream;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const REDACTED = "***";

/** Deux espaces entre colonnes: assez pour separer, assez peu pour tenir en 100 colonnes. */
const COLUMN_GAP = "  ";

const SYMBOL = {
  debug: "·",
  success: "✔",
  warn: "⚠",
  error: "✖",
  rule: "─",
} as const;

interface FrameChars {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly leftTee: string;
  readonly rightTee: string;
  readonly horizontal: string;
  readonly vertical: string;
}

const FANCY_FRAME: FrameChars = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  leftTee: "├",
  rightTee: "┤",
  horizontal: "─",
  vertical: "│",
};

const PLAIN_FRAME: FrameChars = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  leftTee: "+",
  rightTee: "+",
  horizontal: "-",
  vertical: "|",
};

// eslint-disable-next-line no-control-regex -- l octet ESC est precisement ce que l on retire
const ANSI_SEQUENCE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Marques combinantes: elles se posent sur le glyphe precedent et n occupent aucune colonne. */
const COMBINING_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20f0],
  [0xfe20, 0xfe2f],
];

function isCombiningMark(codePoint: number): boolean {
  return COMBINING_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Largeur d affichage en colonnes de terminal. La longueur JavaScript ne convient
 * pas: une lettre accentuee decomposee (un "e" suivi d un accent combinant) compte
 * deux unites mais n occupe qu une colonne, ce qui desaligne les tableaux.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI_SEQUENCE, "").normalize("NFC")) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isCombiningMark(codePoint)) {
      continue;
    }
    width += 1;
  }
  return width;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Un identifiant Mattermost et un token porteur ont exactement le meme format:
 * 26 caracteres [a-z0-9]. Masquer toute suite de cette forme rendrait les logs
 * inexploitables, puisque chaque canal, message et utilisateur y apparait par son
 * identifiant. Seules les valeurs introduites par un mot cle qui les presente
 * comme un secret sont donc masquees. Compromis assume: un token recopie seul,
 * sans aucun contexte, passe au travers.
 */
const TOKEN_IN_CONTEXT = /\b(mm_token|token|bearer)\b(["']?\s*[:=]?\s*["']?)([a-z0-9]{26})\b/gi;

/** Volontairement sans le drapeau i: un vrai identifiant Mattermost est en minuscules. */
const MATTERMOST_ID = /^[a-z0-9]{26}$/;

/**
 * Masque tout ce qui ressemble a un token dans une chaine avant affichage.
 * Le CLI recoit un token porteur qui donne un acces en ecriture a toute
 * l instance: il ne doit jamais atterrir dans un terminal ni dans un log.
 */
export function redactSecrets(text: string, secrets?: readonly string[]): string {
  let result = text;

  if (secrets !== undefined) {
    // Du plus long au plus court: sinon un secret contenu dans un autre serait
    // remplace en premier et laisserait la fin du plus long en clair.
    const ordered = [...secrets]
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length);
    for (const secret of ordered) {
      result = result.split(secret).join(REDACTED);
    }
  }

  return result.replace(
    TOKEN_IN_CONTEXT,
    (match: string, keyword: string, separator: string, value: string): string =>
      MATTERMOST_ID.test(value) ? `${keyword}${separator}${REDACTED}` : match,
  );
}

export class Logger {
  readonly #level: LogLevel;
  readonly #plain: boolean;
  readonly #out: NodeJS.WritableStream;
  readonly #err: NodeJS.WritableStream;
  readonly #colors: ReturnType<typeof pc.createColors>;

  constructor(options?: LoggerOptions) {
    this.#level = options?.level ?? "info";
    this.#plain = options?.plain ?? !process.stdout.isTTY;
    this.#out = options?.out ?? process.stdout;
    this.#err = options?.err ?? process.stderr;
    // createColors(false) renvoie des fonctions identite: aucun octet ANSI ne peut
    // sortir en mode plain, meme si une methode oublie de tester le drapeau.
    this.#colors = pc.createColors(!this.#plain);
  }

  debug(message: string): void {
    if (!this.#allows("debug")) {
      return;
    }
    const prefix = this.#plain ? "[debug]" : this.#colors.dim(SYMBOL.debug);
    this.#emit(this.#out, prefix, message, (line) => this.#colors.dim(line));
  }

  info(message: string): void {
    if (!this.#allows("info")) {
      return;
    }
    this.#emit(this.#out, "", message);
  }

  /** Encadre un titre de section. */
  section(title: string): void {
    if (!this.#allows("info")) {
      return;
    }
    const safe = redactSecrets(title);
    if (this.#plain) {
      this.#out.write(`\n== ${safe} ==\n`);
      return;
    }
    const rule = SYMBOL.rule.repeat(displayWidth(safe));
    this.#out.write(`\n${this.#colors.bold(this.#colors.cyan(safe))}\n${this.#colors.dim(rule)}\n`);
  }

  success(message: string): void {
    if (!this.#allows("info")) {
      return;
    }
    const prefix = this.#plain ? "[ok]" : this.#colors.green(SYMBOL.success);
    this.#emit(this.#out, prefix, message);
  }

  warn(message: string): void {
    if (!this.#allows("warn")) {
      return;
    }
    const prefix = this.#plain ? "[alerte]" : this.#colors.yellow(SYMBOL.warn);
    this.#emit(this.#err, prefix, message, (line) => this.#colors.yellow(line));
  }

  error(message: string): void {
    if (!this.#allows("error")) {
      return;
    }
    const prefix = this.#plain ? "[erreur]" : this.#colors.red(SYMBOL.error);
    this.#emit(this.#err, prefix, message, (line) => this.#colors.red(line));
  }

  /** Rend un tableau simple aligne. Utilise pour le recapitulatif des canaux a joindre. */
  table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    if (!this.#allows("info")) {
      return;
    }

    const safeHeaders = headers.map((header) => redactSecrets(header));
    const safeRows = rows.map((row) => row.map((cell) => redactSecrets(cell)));
    const columnCount = Math.max(safeHeaders.length, ...safeRows.map((row) => row.length), 0);
    if (columnCount === 0) {
      return;
    }

    const widths: number[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      let width = displayWidth(safeHeaders[column] ?? "");
      for (const row of safeRows) {
        width = Math.max(width, displayWidth(row[column] ?? ""));
      }
      widths.push(width);
    }

    const renderRow = (cells: readonly string[]): string => {
      const parts: string[] = [];
      for (let column = 0; column < columnCount; column += 1) {
        parts.push(padToWidth(cells[column] ?? "", widths[column] ?? 0));
      }
      return parts.join(COLUMN_GAP).trimEnd();
    };

    const totalWidth =
      widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP.length * (columnCount - 1);
    const separator = (this.#plain ? "-" : SYMBOL.rule).repeat(totalWidth);
    const headerLine = renderRow(safeHeaders);

    this.#out.write(`${this.#plain ? headerLine : this.#colors.bold(headerLine)}\n`);
    this.#out.write(`${this.#plain ? separator : this.#colors.dim(separator)}\n`);
    for (const row of safeRows) {
      this.#out.write(`${renderRow(row)}\n`);
    }
  }

  /**
   * Message d avertissement encadre et impossible a rater. Utilise pour annoncer
   * les joins, qui publient un message systeme public dans chaque canal.
   */
  callout(title: string, lines: readonly string[]): void {
    if (!this.#allows("warn")) {
      return;
    }

    const safeTitle = redactSecrets(title);
    const safeLines = lines.map((line) => redactSecrets(line));
    const inner = Math.max(displayWidth(safeTitle), ...safeLines.map((line) => displayWidth(line)));
    const frame = this.#plain ? PLAIN_FRAME : FANCY_FRAME;
    const bar = frame.horizontal.repeat(inner + 2);
    const paint = (line: string): string => (this.#plain ? line : this.#colors.yellow(line));
    const paddedTitle = padToWidth(safeTitle, inner);
    const shownTitle = this.#plain ? paddedTitle : this.#colors.bold(paddedTitle);

    const rendered: string[] = [
      `${frame.topLeft}${bar}${frame.topRight}`,
      `${frame.vertical} ${shownTitle} ${frame.vertical}`,
    ];
    if (safeLines.length > 0) {
      rendered.push(`${frame.leftTee}${bar}${frame.rightTee}`);
      for (const line of safeLines) {
        rendered.push(`${frame.vertical} ${padToWidth(line, inner)} ${frame.vertical}`);
      }
    }
    rendered.push(`${frame.bottomLeft}${bar}${frame.bottomRight}`);

    for (const line of rendered) {
      this.#out.write(`${paint(line)}\n`);
    }
  }

  #allows(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.#level];
  }

  #emit(
    stream: NodeJS.WritableStream,
    prefix: string,
    message: string,
    paint: (line: string) => string = (line) => line,
  ): void {
    // Coloration ligne par ligne: une sequence ANSI ouverte sur une ligne et
    // fermee sur une autre corrompt la sortie des que le terminal rogne ou
    // reformate le texte.
    for (const line of redactSecrets(message).split("\n")) {
      stream.write(prefix.length > 0 ? `${prefix} ${paint(line)}\n` : `${paint(line)}\n`);
    }
  }
}
