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

- [ ] Challenger la stack avant de commencer, maintenant que la volumétrie réelle est
      connue : 1,9 M de messages, 43 000 pièces jointes, 25 Go.
- [ ] Builder d'index, API en lecture seule, parser de syntaxe de recherche.
- [ ] Frontend React : canaux, messages virtualisés, threads, permaliens, recherche,
      annuaire.

## Dette identifiée

- [ ] **Codes d'erreur traçables** (§6.1 du guide CLI). 21 classes d'erreur avec de bons
      messages, mais pas de code documenté de type `E1001`. Utile surtout si le paquet est
      publié un jour.
- [ ] **CHANGELOG**. Les conventional commits sont en place, `release-please` ou
      `changesets` le générerait tout seul. Voir `~/source/roadmaps-faciles`.
- [ ] **TypeScript 7**. Le paquet `typescript` reste en 6 : typescript-eslint ne supporte
      pas encore l'API TS 7 (issue upstream 10940). tsgo est déjà en 7 et fournit la
      vitesse. À rebasculer dès que l'issue est close.
- [ ] **`--dry-run` sur `redact`**. La commande modifie l'archive en place sans retour
      possible. Un mode qui annonce ce qui serait supprimé, sans écrire, réduirait le
      risque sur une opération de conformité.
- [ ] **Test d'intégration contre un Mattermost local** en docker-compose, avec données
      seedées : canal archivé, utilisateur désactivé, canal public non rejoint. Tout est
      aujourd'hui vérifié contre un serveur simulé.

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
