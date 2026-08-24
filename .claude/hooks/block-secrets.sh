#!/bin/sh
# Bloque toute lecture/ecriture des fichiers de secrets et toute commande qui les reference.
# Hook PreToolUse - exit 2 = blocage avec message dans stderr.
#
# Exception : les fichiers de reference sans secret (.env.example, .env.sample,
# .env.template) restent lisibles et modifiables, ils sont versionnes.

set -u

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

is_allowed_example() {
  case "$1" in
    *.example | *.sample | *.template) return 0 ;;
    *) return 1 ;;
  esac
}

is_secret_path() {
  base=$(basename -- "$1")
  case "$base" in
    .env | .env.*)
      if is_allowed_example "$base"; then return 1; fi
      return 0
      ;;
    *) return 1 ;;
  esac
}

case "$tool" in
  Read | Write | Edit | NotebookEdit)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
    if [ -n "$path" ] && is_secret_path "$path"; then
      printf '%s\n' "BLOCKED: acces a $path interdit (secrets). Le fichier d environnement n est ni a lire ni a modifier. Utiliser .env.example comme reference." >&2
      exit 2
    fi
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    # Extrait chaque token ressemblant a un chemin de fichier d environnement,
    # puis bloque des qu un seul n est pas une exception versionnee.
    hits=$(printf '%s' "$cmd" | grep -oE '(^|[^A-Za-z0-9_.-])\.env(\.[A-Za-z0-9_.-]+)?' 2>/dev/null | sed 's/^[^.]*//' || true)
    for h in $hits; do
      if ! is_allowed_example "$h"; then
        printf '%s\n' "BLOCKED: la commande reference $h. Interdit (contient des secrets)." >&2
        exit 2
      fi
    done
    ;;
esac

exit 0
