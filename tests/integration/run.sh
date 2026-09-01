#!/usr/bin/env bash
# Monte une instance Mattermost jetable, lance le test d integration, demonte.
#
# L attente se fait depuis l hote parce que l image est distroless : elle ne
# contient ni curl ni shell, donc aucun healthcheck ne peut y tourner. Et c est
# de toute facon la seule verification qui prouve que l API est joignable de la
# ou le test l appellera.
set -euo pipefail

racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose="$racine/tests/integration/compose.yaml"
url="${MM_INTEGRATION_URL:-http://localhost:8065}"

demonter() {
  docker compose -f "$compose" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap demonter EXIT

# La base doit repartir vierge : le premier compte cree devient administrateur,
# et le seeding en depend entierement.
demonter
docker compose -f "$compose" up -d

echo "Attente de l API sur $url"
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "$url/api/v4/system/ping" >/dev/null 2>&1; then
    echo "  API joignable"
    # Surtout pas `exec` : il remplace ce shell, donc le piege de sortie
    # disparait avec lui et les conteneurs restent debout. Le code de retour de
    # vitest est propage a la main, apres le demontage.
    code=0
    MM_INTEGRATION_URL="$url" pnpm vitest run tests/integration || code=$?
    exit "$code"
  fi
  sleep 3
done

echo "L API n a pas repondu en 180 s. Journal du serveur :" >&2
docker compose -f "$compose" logs mattermost --tail 40 >&2
exit 1
