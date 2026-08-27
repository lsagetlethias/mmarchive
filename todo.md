# À faire

État au 25 août 2026. Le bloc 1 (extracteur) est livré et validé sur une extraction réelle
de 1 892 791 messages, 758 canaux, 25 Go, archive conforme.

## Irréversible dans le temps

Ce qui suit ne sera plus rattrapable une fois l'instance décommissionnée.

- [ ] **Extraire les 573 canaux archivés** (891 065 messages). Ils sont lisibles et ne
      coûtent aucun join, mais restent décochés par défaut. Regénérer la sélection avec
      `inventory --select-archived`, puis `run --resume`.
- [ ] **Assurance froide hors périmètre de l'outil** : `pg_dump` de la base plus miroir du
      bucket de stockage objet. L'API ne rend que l'état visible, les messages supprimés et
      l'historique d'édition sont perdus quoi qu'il arrive.
- [ ] Décider du sort de la team `fab-geocommuns`, dont le compte n'est pas membre : ses
      canaux publics sont invisibles. La rejoindre est une écriture (`--join-teams`).

## Bloc 2, viewer

- [x] Challenger la stack avant de commencer, maintenant que la volumétrie réelle est
      connue. Fait, sur mesures : voir `docs/DECISION-INDEX.md`. SQLite et FTS5 sont
      conservés, l'index est unique et lu paresseusement, ce qui rend le mode lite
      dérivable du mode full sans second pipeline.
- [x] **Builder d'index** (`mmarchive-index`). 588 Mo pour 1,3 M de messages, construit
      en 61 s. Invariants couverts par les tests.
- [x] Couche de requêtes **isomorphe**. Les requêtes sont synchrones et ne connaissent
      qu'une interface `SqlDriver` de trois méthodes. Les deux pilotes existent,
      `node:sqlite` et SQLite WASM, sans qu'aucune requête ait eu à changer.
- [x] Parser de syntaxe de recherche (`from:`, `in:`, `before:`, `after:`, `on:`, phrase
      exacte, exclusion, préfixe, `#hashtag`). Les expressions produites sont exécutées
      contre un vrai FTS5 dans les tests, y compris sur une liste de saisies hostiles.
- [x] **Serveur Fastify en lecture seule** (`mmarchive-serve`). Écoute sur 127.0.0.1 par
      défaut. Toute méthode autre que GET et HEAD est refusée par un garde-fou d'exécution,
      doublé d'un test qui interdit qu'une route d'écriture soit déclarée un jour.
      Vérifié sur l'archive réelle : `Range`, `ETag`, 304, `Content-Disposition: attachment`
      avec encodage RFC 5987, `nosniff`, et aucun fichier brut de l'archive exposé.
- [x] **Frontend React** : canaux, messages virtualisés, fils, permaliens, recherche,
      annuaire. Affiche le drapeau `orphanRoot` et les pièces jointes non archivées avec
      leur raison. Aucune ressource distante : polices système, table d'emojis embarquée
      (99,3 % des réactions de l'archive), emojis personnalisés servis depuis l'archive.
- [ ] Rendu des messages, points restants : la table d'emojis laisse 0,7 % des raccourcis
      en clair (`:beach_with_umbrella:`), et le Markdown Mattermost n'est pas couvert en
      entier (les blocs `props` des intégrations ne sont pas rendus, par décision).
- [x] **Mode lite**, dans ses deux transports. SQLite compilé en WebAssembly, VFS de
      lecture seule adossé à un cache de blocs, le tout dans un worker. Aucune requête n'a
      changé : le worker appelle les mêmes fonctions que le serveur.
      Mesuré sur l'archive réelle (index de 655 Mo) : ouvrir un canal coûte 25 requêtes et
      1,6 Mo, sous la seconde. L'ouverture en double-clic exige un artefact distinct
      (`archive.html`, 1,8 Mo, script classique et moteur inclus), parce que Chrome refuse
      les modules et les workers chargés depuis un disque.
- [x] **Le mode full produit le mode lite depuis son interface.** Vue « Emporter », qui
      annonce la taille avant de lancer quoi que ce soit, puis assemble en flux un zip
      contenant l'index, le viewer dans ses deux formes et une notice. Mesuré sur l'archive
      réelle : 690 Mo bruts, 325 Mo une fois compressés, 21 s. Vérifié de bout en bout,
      l'archive extraite s'ouvrant en double-clic avec les mêmes résultats de recherche.
- [ ] Les pièces jointes ne sont pas incluses dans la copie (26 Go) : leur métadonnée est
      affichée avec la mention qui convient. À reconsidérer si une remise complète devient
      nécessaire, par exemple en produisant un second volume à côté du zip.

## Déploiement

- [x] **Image et compose du viewer.** `Dockerfile` multi-étages et `compose.yaml`, vérifiés
      de bout en bout sur l'archive réelle : conteneur `healthy`, utilisateur non
      privilégié, système de fichiers en lecture seule, `cap_drop: ALL`, port publié sur la
      boucle locale uniquement, écriture refusée en 405 et traversée de chemin en 404.
      L'archive et l'index restent dehors, montés en lecture seule. Un service `index` du
      profil `outils` construit l'index à la demande. Voir `docs/DEPLOIEMENT.md`.
- [ ] **Mandataire inverse avec authentification.** Hors périmètre de ce dépôt : le viewer
      n'a aucune authentification et ne prétend pas en avoir. La documentation le dit et le
      défaut protège, mais rien n'empêche quelqu'un de retirer le `127.0.0.1:`.

## Dette identifiée

- [x] **Codes d'erreur traçables** (§6.1 du guide CLI). Les 25 classes d'erreur portent un
      code stable, groupé par famille selon l'origine du problème : `E10xx` la saisie de
      l'utilisateur, `E20xx` l'instance et les garde-fous, `E30xx` l'archive, `E40xx` la
      reprise, `E50xx` l'index. Le registre de `shared/src/errors.ts` est la source de
      vérité, `describeError` préfixe le message à l'affichage, et `docs/CODES-ERREUR.md`
      donne la conduite à tenir pour chaque code. Un test lit les sources et refuse toute
      classe sans code, tout code attribué deux fois et toute entrée orpheline, ce qui
      empêche la documentation de se désynchroniser en silence.
- [x] **CHANGELOG**, traité par le process de release. `release-please` tient une pull
      request de release à jour à chaque fusion sur `main` et génère le CHANGELOG depuis
      les titres de pull requests, que le squash rend seuls porteurs de sens. `changesets`
      a été écarté : il est conçu pour publier des paquets npm à versions indépendantes,
      alors que tout est ici `private` et ne forme qu'un produit. Voir `docs/RELEASE.md`.
- [x] **TypeScript 7**, requalifié : ce n'est pas une dette tant que la répartition est
      nette. TS 7 fait le typecheck (`pnpm typecheck`) et l'analyse dans l'éditeur, via
      l'extension TypeScript (Native Preview). TS 6 ne sert plus qu'à typescript-eslint,
      qui ne lit pas encore l'API de la 7 (issue upstream 10940, toujours ouverte). La
      configuration de l'éditeur est versionnée et dit laquelle sert à quoi.
- [x] **`--dry-run` sur `redact`**. La simulation parcourt et compte exactement ce que
      ferait la vraie passe, sans ouvrir un seul flux d'écriture. Un test compare les deux
      décomptes et vérifie que l'archive est rigoureusement inchangée après simulation.
- [ ] **Test d'intégration contre un Mattermost local** en docker-compose, avec données
      seedées : canal archivé, utilisateur désactivé, canal public non rejoint. Tout est
      aujourd'hui vérifié contre un serveur simulé. Le `compose.yaml` du déploiement ne sert
      pas à cela : il ne parle qu'au viewer, jamais à une instance.

## Non retenu, et pourquoi

Ces points du guide des bonnes pratiques CLI ne sont pas des dettes tant que le paquet
reste privé. À reconsidérer le jour d'une publication, pas avant.

- Complétion shell, hyperlinks cliquables, `npm-shrinkwrap`, image Docker du CLI, URL de
  rapport de bug pré-remplie.
- Lecture sur l'entrée standard : la sélection est un fichier désigné explicitement, la
  piper brouillerait la garantie qu'aucun canal n'est extrait sans avoir été choisi.
- Télémétrie : n'existera jamais ici.

## Leçon à ne pas perdre

Cinq bugs trouvés le même jour appartenaient à une seule famille : **l'état et les fichiers
sont deux sources de vérité concurrentes**, et chaque endroit où l'état décide à la place du
fichier est un bug en puissance. Trois fois, un correctif a créé le suivant. Le garde-fou
qui a fini par tenir est `verify`, lancé automatiquement en fin de run.

Quand un doute surgit sur l'état d'une archive, la réponse est dans les fichiers.
