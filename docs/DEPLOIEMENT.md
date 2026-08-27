# Déploiement du viewer

Ce document ne concerne que le **viewer**. L'extracteur n'est pas déployé : il tourne une
fois, sur un poste, avec un token qui ouvre l'instance en écriture. Ce pouvoir n'a rien à
faire sur un serveur de consultation, et l'image ne le contient pas.

## Ce qu'il faut avant de commencer

Deux choses, produites hors du serveur :

- une **archive**, résultat de `mmarchive-extract run` ;
- un **index**, dérivé de l'archive par `mmarchive-index build`.

Ni l'un ni l'autre n'entre dans l'image. Ils sont montés en lecture seule au démarrage.
Une archive se compte en dizaines de gigaoctets et contient des échanges internes :
l'inclure dans une image la rendrait poussable sur un registre, ce qui est exactement ce
qu'il ne faut pas.

## Le point à lire avant tout le reste

**Le viewer n'a aucune authentification.** Toute personne qui atteint le port atteint la
totalité de l'archive : messages, pièces jointes, avatars, et la liste des membres de
chaque canal. C'est un choix assumé, pas un oubli : l'outil sert une donnée déjà
constituée et ne cherche pas à rejouer une politique d'accès qui vivait dans l'instance
d'origine, laquelle n'existe plus.

La conséquence est simple. Par défaut, `compose.yaml` publie le port **sur la boucle
locale uniquement** :

```yaml
ports:
  - "127.0.0.1:4173:4173"
```

Si l'accès doit dépasser la machine, la protection se met **devant**, dans un mandataire
inverse qui authentifie. Retirer le `127.0.0.1:` sans rien mettre devant expose l'archive
à tout ce qui peut joindre la machine.

Le serveur affiche d'ailleurs un avertissement au démarrage quand il n'écoute pas sur la
boucle locale. Dans un conteneur, il écoute forcément sur `0.0.0.0`, sans quoi il ne
serait joignable par personne : cet avertissement est donc normal ici, et c'est la
publication du port qui fait la frontière.

## Démarrage

```bash
docker compose up -d
```

Par défaut, le compose cherche `./archive` et `./index.db`. Trois variables permettent de
pointer ailleurs sans toucher au fichier :

```bash
MMARCHIVE_ARCHIVE=/srv/mmarchive/archive \
MMARCHIVE_INDEX=/srv/mmarchive/index.db \
MMARCHIVE_PORT=8080 \
docker compose up -d
```

L'archive est servie sur `http://127.0.0.1:4173`.

## Construire l'index

Si l'index n'existe pas encore, ou si l'archive a changé :

```bash
docker compose --profile outils run --rm index
```

Le service écrit `index.db` à côté du compose, ou dans `MMARCHIVE_INDEX_DIR`. L'archive
est montée en lecture seule pendant l'opération : une construction d'index ne peut pas
abîmer la donnée dont elle dérive.

L'index est **toujours reconstruit en entier**, jamais mis à jour. Sur une archive de
l'ordre du million de messages, comptez un fichier de quelques centaines de mégaoctets,
construit en une minute et demie environ en natif. Dans un conteneur, comptez plutôt trois
à cinq fois plus : la lecture de l'archive passe par un montage lié, ce qui est lent sur
Docker Desktop et bien moins pénalisant sur un hôte Linux. Rien ne vit uniquement dans
l'index : le perdre ne coûte que le temps de le refaire.

Numéroter les messages dans l'ordre chronologique trie l'intégralité de la table, et
SQLite déverse ce tri dans des fichiers temporaires. Le service les dirige vers le volume
de sortie via `SQLITE_TMPDIR`, plutôt que vers la mémoire : prévoyez donc à peu près le
double de la taille finale de l'index comme espace libre pendant l'opération.

Après une opération `mmarchive-redact`, l'index doit être reconstruit, sinon il continue
de servir ce qui vient d'être effacé.

## Durcissement

Le compose applique déjà ce qui est applicable à ce service :

| Option                       | Pourquoi elle tient ici                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `read_only: true`            | Le process n'écrit rien : l'index est ouvert en lecture seule et son journal est en mode `delete`, donc SQLite ne crée ni `-wal` ni `-shm` à côté |
| `tmpfs: /tmp`                | Contrepartie du point précédent, pour le peu que la bibliothèque standard pourrait y poser |
| `cap_drop: ALL`              | Servir des fichiers et lire une base ne demande aucune capacité privilégiée     |
| `no-new-privileges`          | Rien dans l'image n'a besoin d'élever ses droits                                |
| Utilisateur non privilégié   | L'image tourne en `node`, jamais en `root`                                      |
| Montages `:ro`               | Le viewer est en lecture seule par construction, le montage le rend vrai au niveau du noyau |

Le zip de la copie autonome, servi par `/lite.zip`, est assemblé en flux et n'est jamais
écrit sur disque : c'est ce qui permet de garder le système de fichiers en lecture seule
malgré une route qui produit un fichier de plusieurs centaines de mégaoctets.

Sur un hôte Linux, les droits sont le seul point d'attention, et ils diffèrent selon le
service. Le viewer a besoin que l'archive et l'index soient **lisibles** par l'utilisateur
`node` (uid 1000) du conteneur. Le service `index`, lui, doit pouvoir **écrire** dans le
répertoire de sortie, qui accueille à la fois l'index et les fichiers temporaires du tri :

```bash
chown -R 1000:1000 /srv/mmarchive
```

Sans cela, la construction échoue sur une erreur d'écriture. Docker Desktop sur macOS et
Windows masque ce point en remappant les propriétaires, ce qui fait que le problème
n'apparaît qu'une fois en production.

## Contrôle de santé

Le contrôle de santé est déclaré dans l'image et non dans le compose : il décrit comment
le viewer se vérifie lui-même, et vaut donc aussi pour un `docker run` lancé à la main. Le
service `index` le désactive, puisqu'il ne sert aucune requête.

L'image déclare un `HEALTHCHECK` qui interroge `/api/meta`. Ce point d'entrée compte
réellement les lignes de l'index : un conteneur sain prouve donc à la fois que le serveur
répond et que sa base est lisible, là où une simple ouverture de port ne dirait rien. Le
comptage porte sur l'intégralité des messages en quelques millisecondes, le coût est
négligeable à cette cadence.

```bash
docker compose ps
```

## Mettre à jour

```bash
docker compose build --pull
docker compose up -d
```

L'archive et l'index ne bougent pas : ils sont dehors. Une mise à jour du viewer ne touche
jamais la donnée, ce qui est le sens de la séparation entre les deux.

## Ce que le déploiement ne fait pas

- Il ne sauvegarde pas l'archive. Elle est la donnée durable, elle mérite une sauvegarde
  propre ; l'index, non, il se reconstruit.
- Il ne termine pas TLS. C'est le rôle du mandataire inverse.
- Il ne journalise pas les accès par défaut. `--verbose` active la journalisation de
  chaque requête si vous en avez besoin.
