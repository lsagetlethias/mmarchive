---
name: add-tests
description: Ajoute des tests Vitest pour du code existant de mmarchive. À utiliser quand l'utilisateur demande des tests, quand une fonction critique n'est pas couverte, ou après avoir écrit une logique de sélection, un parser ou une transformation de données.
---

# add-tests

## Où vont les tests

Miroir de `src/` dans `tests/` du même package :

```
packages/shared/src/selection.ts   →  packages/shared/tests/selection.test.ts
packages/extractor/src/foo/bar.ts  →  packages/extractor/tests/foo-bar.test.ts
```

Vitest est configuré à la racine (`vitest.config.ts`), avec l'alias `@mmarchive/shared`.
Pattern collecté : `packages/*/tests/**/*.test.ts`.

## Priorités de couverture

Par ordre d'importance décroissante pour ce projet :

1. **Logique de sélection des canaux** (`shared/src/selection.ts`). Catégorisation
   joined / non rejoint / archivé, calcul des joins induits. C'est là que se joue la
   contrainte la plus importante du projet.
2. **Garde-fous** (`shared/src/guards.ts`). Aucun canal `P`, `D` ou `G` ne doit pouvoir
   passer.
3. **Parser de syntaxe de recherche** (bloc 2). La partie la plus piégeuse du viewer.
4. **Chunker RAG** (bloc 2, optionnel).
5. **Client HTTP** : rate limiting, backoff sur 429 avec `Retry-After`, retry sur 5xx,
   refus des méthodes d'écriture.
6. **Pagination et reprise** : curseur, `--resume` au milieu d'un canal, inversion
   chronologique du fichier `.part`.

## Style

- Un `describe` par fonction publique, un `it` par comportement, libellé en français
  et décrivant le comportement attendu, pas l'implémentation.
- Des factories locales (`function channel(overrides = {})`) plutôt que des littéraux
  répétés.
- `it.each` pour les variantes d'un même comportement (les types de canaux, par
  exemple).
- Teste les cas limites explicitement : valeur absente, `undefined`, tableau vide,
  compteur à zéro.
- Pour tout ce qui touche aux effets de bord sur l'instance, écris un test qui vérifie
  que l'effet **n'a pas lieu** dans le cas nominal. C'est plus important que le test du
  cas passant.

## Vérifications défensives obligatoires

Ces trois-là doivent rester couvertes en permanence. Si tu touches au code concerné,
vérifie qu'elles passent toujours :

- aucun canal de type `P`, `D` ou `G` ne peut se retrouver dans l'archive ;
- aucun join n'est émis pour un canal absent de la sélection ;
- le mode par défaut, sans `--file`, n'émet strictement aucune requête d'écriture.

## Finir

Lance `pnpm test`. Si un nouveau test échoue, détermine si c'est le code ou le test qui
a tort avant de corriger. N'assouplis jamais un test pour obtenir du vert.
