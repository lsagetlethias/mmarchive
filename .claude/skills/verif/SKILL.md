---
name: verif
description: Lance le pipeline de vérification complet du repo (typecheck, lint, format, tests, build) et corrige les erreurs remontées. À utiliser avant toute livraison, avant un commit, ou quand l'utilisateur demande "verif", "vérifie", "ça passe ?".
---

# verif

Pipeline de vérification de mmarchive. L'objectif est un repo vert, pas un rapport.

## Procédure

1. Lance `pnpm verify` à la racine. Il enchaîne dans cet ordre :
   `typecheck` → `lint` → `fmt:check` → `test` → `build`.

2. Si le pipeline échoue, **corrige** plutôt que de rapporter. Ordre de traitement :

   - **typecheck** en premier. `tsgo --noEmit`. Si tsgo remonte quelque chose de
     douteux (il est en beta), recoupe avec `pnpm typecheck:tsc` avant de conclure.
   - **lint** ensuite. `pnpm lint:fix` d'abord pour l'automatisable, puis à la main.
     Ne désactive une règle qu'avec un commentaire justifiant le POURQUOI, jamais pour
     faire taire le linter.
   - **fmt** : `pnpm fmt` règle tout, c'est mécanique.
   - **test** : un test qui échoue signale soit un bug, soit un test faux. Détermine
     lequel avant de toucher quoi que ce soit. **Ne supprime jamais un test, ne
     l'assouplis jamais, pour obtenir du vert.**
   - **build** : `tsup` sur l'extracteur.

3. Relance `pnpm verify` jusqu'au vert complet.

## Vérifications spécifiques à mmarchive

Au-delà du pipeline, contrôle que les garde-fous du projet tiennent toujours :

- Aucune comparaison inline `type === "O"` hors de `packages/shared/src/guards.ts`.
  Tout passe par `isPublicChannel` / `assertPublicChannel`.
  ```bash
  grep -rn '"O"' packages --include='*.ts' | grep -v 'shared/src/guards.ts' | grep -v 'shared/src/constants.ts'
  ```
- Aucun appel HTTP en écriture hors de la porte de consentement.
  ```bash
  grep -rn 'method: *"\(POST\|PUT\|DELETE\|PATCH\)"' packages --include='*.ts'
  ```
  Chaque occurrence doit être justifiée et passer par `MutationGate`, sauf
  `POST /users/ids` qui est une lecture déguisée.
- Les tests des trois vérifications défensives passent bien :
  aucun canal `P`/`D`/`G` dans l'archive, aucun join hors sélection, mode par défaut
  sans aucune requête d'écriture.

## Rapport

Termine par un état factuel : ce qui passe, ce qui a été corrigé, ce qui reste rouge et
pourquoi. Si quelque chose n'a pas pu être vérifié, dis-le explicitement plutôt que de
laisser croire que c'est vert.
