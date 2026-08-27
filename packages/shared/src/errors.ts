/**
 * Codes d erreur de mmarchive.
 *
 * Un message se reformule, se traduit, se precise ; un code ne bouge pas. Quand
 * quelqu un rapporte une panne des mois plus tard, souvent par capture d ecran,
 * c est le code qui permet de retrouver la cause sans dependre du texte exact.
 *
 * Les familles disent d ou vient le probleme, ce qui oriente deja la reponse :
 *
 * - E10xx : la ligne de commande ou un fichier fourni par l utilisateur
 * - E20xx : l instance Mattermost, le reseau, les garde-fous d ecriture
 * - E30xx : le format d archive, sa lecture, ses chemins
 * - E40xx : l etat de reprise
 * - E50xx : l index de consultation
 *
 * Ce registre est la source de verite : une classe d erreur qui n y figure pas
 * fait echouer les tests, et un code employe deux fois aussi.
 */
export const ERROR_CODES = {
  OptionsError: "E1001",
  SelectionFileError: "E1002",
  SelectionMismatchError: "E1003",

  MattermostError: "E2001",
  MattermostHttpError: "E2002",
  MattermostAuthError: "E2003",
  MattermostForbiddenError: "E2004",
  MattermostNotFoundError: "E2005",
  MattermostRateLimitError: "E2006",
  MattermostResponseError: "E2007",
  NetworkError: "E2008",
  ForbiddenMutationError: "E2009",
  ConsentViolationError: "E2010",
  NonPublicChannelError: "E2011",

  NdjsonReadError: "E3001",
  NdjsonParseError: "E3002",
  NdjsonWriteError: "E3003",
  NdjsonSerializeError: "E3004",
  ArchivePathError: "E3005",
  UnsafeArchivePathError: "E3006",
  ReverseFileError: "E3007",

  StateCorruptedError: "E4001",
  StateMismatchError: "E4002",

  IndexBuildError: "E5001",
  IndexReadError: "E5002",
} as const;

export type ErrorName = keyof typeof ERROR_CODES;
export type ErrorCode = (typeof ERROR_CODES)[ErrorName];

const CODES = new Set<string>(Object.values(ERROR_CODES));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/**
 * Rend une erreur lisible dans un terminal, prefixee de son code s il existe.
 *
 * Le code precede le texte plutot que de le suivre : c est le premier element
 * lu, et le seul a retenir pour chercher. La verification contre le registre
 * evite de confondre nos codes avec ceux que Node pose sur ses propres erreurs,
 * ou "code" vaut ENOENT ou EACCES.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code: unknown };
    if (isErrorCode(code)) return `[${code}] ${message}`;
  }
  return message;
}

/**
 * Code systeme pose par Node sur ses erreurs d entree-sortie, ENOENT ou EACCES.
 *
 * Distinguer l absence du reste est la difference entre un fichier qui n existe
 * pas, ce qui est souvent normal, et un fichier qu on n arrive pas a lire, ce
 * qui ne l est jamais. Confondre les deux fait echouer plus loin, sur un
 * message qui ne designe plus la cause.
 */
export function systemErrorCode(cause: unknown): string | undefined {
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
}
