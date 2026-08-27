#!/usr/bin/env bash
#
# Reglages du depot, a appliquer une fois avec le CLI gh authentifie.
#
#   ./.github/setup-repo.sh
#
# Le script est idempotent : le relancer reapplique les memes reglages sans rien
# casser. Il n est pas execute automatiquement, parce qu il touche a un depot
# distant et que c est une decision, pas une etape de build.

set -euo pipefail

REPO="${1:-lsagetlethias/mmarchive}"

echo "Depot : ${REPO}"

# Fusion par squash uniquement.
#
# Le workflow pr-title verifie que le titre de la pull request suit la
# convention de commit, precisement parce que c est ce titre que reprend le
# commit de fusion. Autoriser les autres modes ferait entrer dans main des
# messages que commitlint n a jamais vus.
gh api -X PATCH "repos/${REPO}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F squash_merge_commit_title=PR_TITLE \
  -F squash_merge_commit_message=PR_BODY \
  --silent

# Protection de main.
#
# Les deux verifications exigees sont les noms des jobs des workflows :
# "verify" enchaine typecheck, lint, format, tests et build ; "conventional"
# valide le titre de la pull request.
#
# strict a true impose que la branche soit a jour avant fusion : sans cela, deux
# pull requests vertes separement peuvent casser main une fois reunies.
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  --input - <<'JSON' --silent
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["verify", "conventional"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

echo "Reglages appliques."
echo
echo "Ce qui est desormais interdit sur main : la poussee directe sans pull"
echo "request, la reecriture d historique, la suppression de la branche, et la"
echo "fusion tant que verify et conventional ne sont pas verts."
echo
echo "enforce_admins reste a false : un administrateur du depot peut donc passer"
echo "outre. Sur un depot a un seul mainteneur, c est une porte de sortie voulue"
echo "plutot qu une faille, mais elle signifie que la regle guide sans contraindre."
echo "Passez le a true pour qu elle s applique aussi a vous."
echo
echo "Le nombre de relecteurs exige est zero : sur un depot a un seul mainteneur,"
echo "en demander un se contourne en s auto-approuvant, ce qui donne l illusion"
echo "d un controle. La barriere utile ici est la verification automatique."
