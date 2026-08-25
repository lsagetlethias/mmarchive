/**
 * Conditions d execution du terminal.
 *
 * Un CLI qui pose une question dans un contexte non interactif ne se contente
 * pas d etre desagreable : il se bloque. En integration continue, dans un cron
 * ou derriere un tube, personne ne repondra jamais, et le processus attend
 * indefiniment au lieu d echouer avec un message exploitable.
 */
export interface EnvironmentOptions {
  readonly stdin?: NodeJS.ReadStream | undefined;
  readonly stdout?: NodeJS.WriteStream | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /** Force le mode non interactif, quel que soit le terminal. */
  readonly noInput?: boolean | undefined;
}

/**
 * L utilisateur peut-il repondre a une question maintenant ?
 *
 * Exige un terminal des DEUX cotes : une entree redirigee signifie que des
 * donnees arrivent par un tube, et les consommer comme reponse a une invite
 * serait pire que de refuser.
 */
export function isInteractive(options: EnvironmentOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (options.noInput === true || env.MMARCHIVE_NO_INPUT !== undefined) return false;
  if (isCi(env)) return false;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** Variables posees par les integrations continues courantes. */
export function isCi(env: Record<string, string | undefined> = process.env): boolean {
  return (
    toBoolean(env.CI) ||
    env.CONTINUOUS_INTEGRATION !== undefined ||
    env.BUILD_NUMBER !== undefined ||
    env.GITHUB_ACTIONS !== undefined ||
    env.GITLAB_CI !== undefined
  );
}

/**
 * La sortie doit-elle etre coloree ?
 *
 * NO_COLOR est une convention interplateforme : sa simple presence, meme vide,
 * suffit a demander une sortie sans couleur.
 */
export function supportsColor(options: EnvironmentOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined) return false;
  if (toBoolean(env.FORCE_COLOR)) return true;
  const stdout = options.stdout ?? process.stdout;
  return stdout.isTTY === true;
}

function toBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Message a afficher quand une valeur manque et qu on ne peut pas la demander.
 * Doit toujours nommer le drapeau ET la variable d environnement : l utilisateur
 * qui lit ca dans un journal d integration continue n a pas de terminal.
 */
export function missingInputMessage(what: string, flag: string, envVar?: string): string {
  const sources =
    envVar === undefined
      ? `Passez ${flag}.`
      : `Passez ${flag} ou renseignez la variable d environnement ${envVar}.`;
  return `${what} manquant, et aucun terminal interactif pour le demander. ${sources}`;
}
