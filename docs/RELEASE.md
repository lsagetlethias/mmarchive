# Process de release

## Comment ça marche

Chaque fusion sur `main` alimente une pull request de release, tenue à jour par
[release-please](https://github.com/googleapis/release-please). Elle accumule le CHANGELOG
et le numéro de version calculés depuis les commits, et ne fait rien d'autre tant que
personne ne la fusionne.

**Sortir une version, c'est fusionner cette pull request.** Le moment reste une décision
humaine : rien ne part parce qu'une fonctionnalité a été mergée.

À la fusion, le workflow enchaîne tout seul :

1. le tag `vX.Y.Z` est posé et la GitHub Release publiée ;
2. `CHANGELOG.md` et les quatre `package.json` sont mis à jour ;
3. l'image du viewer est construite pour `linux/amd64` et `linux/arm64`, puis poussée sur
   `ghcr.io/lsagetlethias/mmarchive-viewer` en `X.Y.Z` et en `latest` ;
4. l'image publiée est démarrée pour vérifier qu'elle répond, avant que quiconque
   l'installe.

## Ce qui décide du numéro

Les conventional commits, via le titre des pull requests : les fusions étant faites en
squash, c'est le titre qui devient le commit de `main`, et donc la ligne du CHANGELOG.

| Titre de la pull request | Effet sur la version                   |
| ------------------------ | -------------------------------------- |
| `fix: ...`               | correctif, `1.2.3` vers `1.2.4`        |
| `feat: ...`              | mineure, `1.2.3` vers `1.3.0`          |
| `feat!: ...` ou `BREAKING CHANGE:` dans le corps | majeure, `1.2.3` vers `2.0.0` |
| `docs:`, `chore:`, `refactor:`, `perf:` | aucun changement de version, mais figure au CHANGELOG |
| `test:`, `ci:`, `build:`, `style:` | rien, ces entrées sont masquées |

Pour forcer un numéro, ajoutez une ligne `Release-As: 1.0.0` dans le corps du commit de
fusion. C'est ce qui permet de sortir la première version stable sans attendre qu'un
changement cassant se présente.

## Une seule version pour tout le dépôt

Les trois paquets sont un produit, pas trois bibliothèques. Ils portent donc le même
numéro : `release-please` met à jour le `package.json` de la racine et, par `extra-files`,
ceux de `shared`, `extractor` et `viewer`.

Ce n'est pas cosmétique. `TOOL_VERSION` est injecté au build depuis ces fichiers : sans
cela, `mmarchive-extract --version` annoncerait un numéro qui ne correspond à aucune
release, et le tag de l'image ne voudrait plus rien dire.

## La version du format d'archive est indépendante

`docs/ARCHIVE_FORMAT.md` porte son propre numéro de schéma, qui ne suit pas celui de
l'outil et ne doit jamais être aligné dessus.

L'archive est la donnée durable ; l'outil est ce qui la produit et la relit. Sortir
l'outil en `2.0.0` ne rend pas les archives existantes illisibles, et le schéma ne change
que lorsque la structure des fichiers change réellement. Toute évolution du format passe
par `docs/ARCHIVE_FORMAT.md` et par les schémas zod de `shared`, les deux ensemble, et ce
sont eux qui décident du numéro de schéma.

## Pourquoi tout tient dans un seul workflow

Le build de l'image vit dans `release.yml`, conditionné à la sortie `release_created`,
plutôt que dans un workflow déclenché par le tag.

La raison est une protection de GitHub contre les boucles : un tag posé avec le
`GITHUB_TOKEN` du workflow ne redéclenche aucun autre workflow. Un `on: push: tags` ne
partirait donc jamais, et il faudrait créer une GitHub App uniquement pour contourner
cela. Tout enchaîner dans un job évite cette machinerie.

## À faire une fois, après la toute première release

Un package poussé sur ghcr.io par un workflow naît **privé**, même quand le dépôt qui le
produit est public. Tant qu'il n'est pas ouvert, `docker pull` anonyme échoue et le
`docker compose pull` documenté plus haut ne fonctionne que pour quelqu'un
d'authentifié.

Après la première release, sur la page du package (`github.com/users/<vous>/packages`),
il faut donc passer sa visibilité à **public**. C'est une action manuelle et unique : les
releases suivantes conservent le réglage.

Sans cela, il reste la voie authentifiée, à réserver aux cas où l'image doit rester
fermée :

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <vous> --password-stdin
```

## Vérifier une release

```bash
docker pull ghcr.io/lsagetlethias/mmarchive-viewer:latest
docker run --rm ghcr.io/lsagetlethias/mmarchive-viewer:latest --version
```

Le déploiement récupère la nouvelle image ainsi :

```bash
docker compose pull && docker compose up -d
```

L'archive et l'index ne bougent pas : ils sont montés depuis l'extérieur. Reconstruire
l'index n'est nécessaire que si le format de l'index a changé, ce que le CHANGELOG
signale.

## Ce que la release ne fait pas

- **Aucune publication sur npm.** Tous les paquets sont `private`, et le livrable est
  l'image plus le dépôt, pas des paquets à installer.
- **Aucun déploiement.** L'image est publiée, la mettre en service reste manuel : les
  machines qui hébergent une archive n'ont pas vocation à se mettre à jour toutes seules.
