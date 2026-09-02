/**
 * Generation des scripts de completion shell.
 *
 * La description du binaire est passee par l appelant plutot que lue ici : ce
 * module ne connait pas commander, et n a donc rien a faire entrer dans le
 * bundle du frontend, qui importe ce paquet.
 *
 * Chaque CLI derive sa description de son propre programme au lieu de la
 * recopier. Une sous-commande ajoutee est donc completee sans que personne y
 * pense, ce qui est le seul moyen qu une completion ne mente pas.
 */

export interface CompletionSubcommand {
  readonly name: string;
  readonly description: string;
  readonly options: readonly string[];
}

export interface CompletionSpec {
  readonly binary: string;
  /** Options acceptees avant toute sous-commande. */
  readonly globalOptions: readonly string[];
  readonly subcommands: readonly CompletionSubcommand[];
}

/**
 * Ce que ce module a besoin de savoir d un programme commander.
 *
 * Decrit structurellement plutot qu importe : `Command` y correspond sans que
 * ce paquet ait a dependre de commander, qui n a rien a faire ici.
 */
export interface DescribableCommand {
  name(): string;
  description(): string;
  readonly options: readonly {
    readonly short?: string | undefined;
    readonly long?: string | undefined;
  }[];
  readonly commands: readonly DescribableCommand[];
}

/**
 * Decrit un programme a partir de lui-meme.
 *
 * Une completion ecrite a la main ment des la premiere sous-commande ajoutee,
 * et c est le pire des deux mondes : elle a l air de savoir. Commander garde
 * l aide hors de `options` alors que toutes les commandes l acceptent, d ou son
 * ajout explicite.
 */
export function describeProgram(program: DescribableCommand): CompletionSpec {
  const drapeaux = (commande: DescribableCommand): string[] =>
    commande.options.flatMap((option) =>
      [option.short, option.long].filter((flag): flag is string => flag !== undefined),
    );
  return {
    binary: program.name(),
    globalOptions: [...drapeaux(program), "-h", "--help"],
    subcommands: program.commands.map((commande) => ({
      name: commande.name(),
      description: commande.description(),
      options: drapeaux(commande),
    })),
  };
}

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** Un identifiant de fonction shell ne prend ni tiret ni point. */
function slug(binary: string): string {
  return binary.replace(/[^A-Za-z0-9]/g, "_");
}

/** Les descriptions traversent des guillemets simples dans les trois shells. */
function echapper(texte: string): string {
  return texte.replace(/'/g, "'\\''");
}

function bash(spec: CompletionSpec): string {
  const nom = `_${slug(spec.binary)}`;
  const cas = spec.subcommands.map((sub) => `    ${sub.name}) opts="${sub.options.join(" ")}" ;;`);
  return [
    `${nom}() {`,
    "  local cur opts cmd mot",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local cmds="${spec.subcommands.map((s) => s.name).join(" ")}"`,
    `  opts="${spec.globalOptions.join(" ")}"`,
    // La sous-commande n est pas forcement le mot 1 : commander accepte les
    // options globales avant elle, et « prog --verbose inventory » est valide.
    '  cmd=""',
    '  for mot in "${COMP_WORDS[@]:1:${COMP_CWORD}}"; do',
    '    case " ${cmds} " in *" ${mot} "*) cmd="${mot}"; break ;; esac',
    "  done",
    '  case "${cmd}" in',
    ...cas,
    "  esac",
    '  if [ -z "${cmd}" ]; then',
    '    COMPREPLY=($(compgen -W "${cmds} ${opts}" -- "${cur}"))',
    "  else",
    '    COMPREPLY=($(compgen -W "${opts}" -- "${cur}"))',
    "  fi",
    "}",
    `complete -F ${nom} ${spec.binary}`,
    "",
  ].join("\n");
}

function zsh(spec: CompletionSpec): string {
  const nom = `_${slug(spec.binary)}`;
  const descriptions = spec.subcommands.map(
    (sub) => `    '${sub.name}:${echapper(sub.description)}'`,
  );
  const cas = spec.subcommands.map(
    (sub) => `      ${sub.name}) opts=(${sub.options.map((o) => `'${o}'`).join(" ")}) ;;`,
  );
  return [
    `#compdef ${spec.binary}`,
    `${nom}() {`,
    "  local -a cmds opts",
    "  cmds=(",
    ...descriptions,
    "  )",
    `  opts=(${spec.globalOptions.map((o) => `'${o}'`).join(" ")})`,
    `  local -a noms; noms=(${spec.subcommands.map((sub) => `'${sub.name}'`).join(" ")})`,
    "  local cmd=''",
    "  local mot",
    "  for mot in ${words[2,-1]}; do",
    "    if (( ${noms[(I)$mot]} )); then cmd=$mot; break; fi",
    "  done",
    "  if [[ -z $cmd ]]; then",
    "    _describe 'commande' cmds",
    "    _describe 'option' opts",
    "  else",
    "    case $cmd in",
    ...cas,
    "    esac",
    "    _describe 'option' opts",
    "  fi",
    "}",
    `compdef ${nom} ${spec.binary}`,
    "",
  ].join("\n");
}

/**
 * Fish distingue le court du long : `-s v` et `-l verbose`. Tout passer en `-l`
 * declarerait une option longue « --h » que le binaire ne connait pas.
 */
function drapeauFish(option: string): string {
  return option.startsWith("--") ? `-l '${option.slice(2)}'` : `-s '${option.slice(1)}'`;
}

function fish(spec: CompletionSpec): string {
  const lignes: string[] = [];
  for (const sub of spec.subcommands) {
    lignes.push(
      `complete -c ${spec.binary} -n '__fish_use_subcommand' -a '${sub.name}' -d '${echapper(sub.description)}'`,
    );
  }
  for (const option of spec.globalOptions) {
    lignes.push(`complete -c ${spec.binary} ${drapeauFish(option)}`);
  }
  for (const sub of spec.subcommands) {
    for (const option of sub.options) {
      lignes.push(
        `complete -c ${spec.binary} -n '__fish_seen_subcommand_from ${sub.name}' ${drapeauFish(option)}`,
      );
    }
  }
  return `${lignes.join("\n")}\n`;
}

export function generateCompletion(spec: CompletionSpec, shell: CompletionShell): string {
  if (shell === "bash") return bash(spec);
  if (shell === "zsh") return zsh(spec);
  return fish(spec);
}
