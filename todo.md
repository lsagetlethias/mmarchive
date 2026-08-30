# À faire

État au 27 août 2026. L'extracteur et le viewer sont livrés, le déploiement et le process
de release aussi, et une version 0.2.0 est sortie pour valider la chaîne de bout en bout.

## Tranché en cours de route

Ces points ont été ouverts puis fermés par décision, pas par oubli. Ils restent listés
pour qu'ils ne reviennent pas.

- Les **canaux archivés** ne seront pas extraits. La sélection sait les prendre, et
  quelqu'un d'autre pourra s'en servir, mais ce n'est pas le besoin ici.
- Pas d'**assurance froide** par vidage de base ni miroir du stockage objet : hors du
  périmètre depuis le début, et l'accès à la base n'existera jamais. La conséquence est
  assumée et documentée : messages supprimés et historique d'édition sont perdus, l'API ne
  rendant que l'état visible.
- Les **teams dont le compte n'est pas membre** ne seront pas rejointes. Leurs canaux
  publics restent invisibles à l'extraction ; ce qui compte est que le cas soit signalé à
  l'utilisateur, ce que `doctor` et l'inventaire font.

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

## Bloc 3, RAG

Cinq morceaux livrés, tous ceux qui ne dépendent pas du modèle : découpage, simulation,
réserve de fragments, recherche lexicale et fusion. La suite attend deux décisions qui
appartiennent à l'exploitant, la dimension des vecteurs et une clé d'API. La marche à
suivre pour trancher la dimension est écrite dans `docs/DECISION-RAG.md`, section « Choisir
la dimension sans payer plusieurs fois » : elle tient en une passe d'embedding sur un
échantillon, le modèle retenu se laissant tronquer sans recalcul.

Optionnel par construction : l'outil doit rester pleinement fonctionnel sans, et le RAG ne
concerne que le mode full. Le mode lite tourne dans un navigateur sans serveur, il n'a ni
clé d'API ni moteur d'inférence, et rien ne doit l'y contraindre.

Le cadrage est fait et le découpage livré : mesures sur l'archive réelle et recherche
documentaire dans `docs/DECISION-RAG.md`. Le découpage produit 297 515 fragments pour
79,3 M tokens, indexés en environ 80 minutes pour 7,93 EUR, ou moitié moins en mode batch.
Modèle recommandé `qwen3-embedding-8b`, tronqué à 1 024 dimensions et quantifié, soit
305 Mo de vecteurs dans un fichier séparé de l'index de consultation.

Trois conclusions du premier jet ont été corrigées par la recherche, et ce sont elles qu'il
faut retenir. La médiane courte n'est pas un défaut : les encodeurs saturent dès 32
tokens, et le vrai problème est la perte de référent, pas la longueur. Le recouvrement
n'apporte rien de mesurable. Et la fusion par rang réciproque est battue par une combinaison
convexe de scores normalisés quand il n'y a que deux listes à fusionner.

- [ ] **Activation par configuration**, désactivé par défaut : `RAG_ENABLED`,
      `RAG_BASE_URL`, `RAG_API_KEY`, `RAG_CHAT_MODEL`, `RAG_EMBED_MODEL`, `RAG_EMBED_DIM`.
      Client générique compatible OpenAI. **Le calcul distant est acté**, le moteur local
      écarté : l'interface reste générique, mais le défaut documenté vise un fournisseur.
      Ce choix a une contrepartie à traiter avant la première indexation, puisque 89,4 M
      tokens d'échanges internes sortiront de la machine qui les héberge : conservation,
      exclusion de la réutilisation pour l'entraînement, région, contrat de sous-traitance.
      Voir `docs/DECISION-RAG.md`.
- [x] **Découpage par fil, jamais par message.** Un « +1 » isolé est illisible hors
      contexte et pollue la recherche. Unité de base : la racine et ses réponses. Hors fil,
      fenêtre glissante coupée sur un écart de plus de trente minutes ou une quarantaine de
      messages. Cible d'environ 800 tokens, en-tête de contexte donnant canal, date et
      participants, puis une ligne par message.
      Livré dans `rag/chunk.ts`, fonction pure sans accès disque ni réseau, et
      `mmarchive-index plan-chunks` simule le découpage sans rien envoyer : c'est l'outil
      qui sert à régler la coupure temporelle, la seule variable qui pilote réellement le
      résultat. Zéro recouvrement, conformément aux mesures du cadrage.
- [ ] **`mmarchive-index embed`**, avec un mode simulation qui annonce le nombre de
      fragments, de tokens et le coût avant d'engager quoi que ce soit. Les vecteurs sont
      calculés une fois et stockés, jamais recalculés à l'exécution.
- [x] **Réserve de fragments** dans `vectors.db`, distincte de l'index de consultation.
      Portée par `rag/chunk-store.ts`, écrite par `mmarchive-index chunks` : 297 515
      fragments et 293 Mo de texte en 15 secondes sur l'archive de référence.
      Le garde-fou qui compte n'est pas le schéma mais l'empreinte : les fragments
      désignent les messages par leur position, qui se décale dès qu'un message est ajouté
      ou effacé. Servir une réserve périmée ferait citer au RAG des messages que personne
      n'a écrits, sans la moindre erreur visible. L'empreinte de l'index est donc stockée
      et revérifiée à l'ouverture, pour moins d'une seconde sur 1,3 million de messages.
      Elle couvre tout ce dont dépend le rendu : les identifiants, mais aussi les noms
      d'utilisateurs et de canaux, et le texte des messages. Une pseudonymisation laisse les
      messages en place et une réserve construite avant restituerait les identités qu'on
      venait d'effacer ; un message édité garde son identifiant et sa place, et la réserve
      servirait la version d'avant. Coût mesuré : 2,5 s à l'ouverture, sur 1,3 million de
      messages.
- [ ] **Stockage vectoriel** via `sqlite-vec`, à côté des fragments dans le même fichier.
      Prévoir la quantification : 200 000 fragments en flottants sur 1024 dimensions pèsent
      environ 800 Mo, l'entier 8 bits divise par quatre.
- [ ] **Recherche hybride.** La moitié lexicale est livrée : `rag/lexical.ts` cherche dans
      les fragments par FTS5, classe par pertinence et rend un score utilisable par la
      fusion. Elle écarte les mots trop répandus en mesurant le corpus plutôt qu'avec une
      liste de mots vides, ce qui divise par trois la durée d'une question ordinaire sans
      déplacer les premiers résultats. Reste la moitié vectorielle et la fusion.
      Indispensable sur du dialogue plein de jargon, d'acronymes et de noms propres que le
      vectoriel rate. La fusion est livrée aussi : `rag/fusion.ts`, fonction pure, met les
      deux moitiés sur la même échelle avant de les mélanger et garde ce qu'une seule
      d'entre elles a trouvé, au lieu de ne retenir que l'intersection. Reste la moitié
      vectorielle, qui attend le choix de dimension.
      Cinquante résultats FTS5, cinquante vectoriels, puis fusion par
      **combinaison convexe de scores normalisés**, poids de
      0,6 à 0,8 sur le vectoriel, et huit à douze fragments retenus. Le cahier des charges
      initial prescrivait une fusion par rang réciproque : deux mesures indépendantes
      montrent qu'elle est battue de 0,015 à 0,032 nDCG dès lors qu'il n'y a que deux
      listes à fusionner. RRF ne reste qu'un repli si la simplicité prime.
- [ ] **Génération** en flux, avec une consigne stricte : répondre uniquement à partir des
      extraits, citer les identifiants de messages, dire quand l'information est absente de
      l'archive. Les citations deviennent des pastilles cliquables vers le permalien, la
      réponse cite et le viewer montre le contexte.
- [ ] Limitation de débit sur la route et comptage des tokens consommés.

## Écarts avec le cadrage initial

Relevés en relisant le cahier des charges d'origine. Aucun n'est bloquant, mais ils
méritent d'être vus plutôt que découverts.

- [ ] **Aucune authentification, même optionnelle.** Le cadrage prévoyait « un basic auth
      optionnel par variable d'environnement, et la mise derrière un mandataire inverse ».
      Ni l'un ni l'autre n'est livré, et le mandataire ne le sera pas : il vit hors de ce
      dépôt. Ce que le dépôt fournit, c'est une écoute limitée à la boucle locale et une
      documentation qui explique quoi placer devant. Défendable pour un service qui n'a
      aucune raison d'être exposé directement, mais le basic auth manque bel et bien.
- [ ] **Pas d'autocomplétion sur `from:` et `in:`.** Le cadrage la demandait à la frappe.
      Le parser gère les deux modificateurs et l'aide de la vue recherche les documente,
      mais rien ne complète pendant la saisie.
      Le travail est entièrement côté interface : `data.tsx` charge déjà la liste complète
      des canaux et des utilisateurs au démarrage, la même que celle qui sert à résoudre les
      mentions, donc aucune route ni aucun aller-retour réseau n'est à ajouter. Reste à
      détecter le modificateur en cours de saisie dans le champ de recherche, à proposer les
      valeurs correspondantes et à gérer la navigation au clavier. À faire en même temps que
      la coloration des modificateurs, qui vient du même cadrage et touche le même champ.
- [ ] Pas de route `GET /api/users/:id` : l'annuaire complet est servi d'un coup par
      `/api/users`, ce qui suffit au frontend actuel et évite une requête par message.
- Noms divergents du cahier des charges, sans conséquence : `mmarchive-index build` plutôt
  que `mmarchive build`, `/api/channels/:id/messages` plutôt que `/posts`,
  `/api/threads/:id` plutôt que `/api/posts/:id/thread`, `/files/:fid` plutôt que
  `/api/files/:file_id`.
- Choix techniques assumés et documentés : `node:sqlite` au lieu de `better-sqlite3`, ce
  qui supprime toute dépendance native ; FTS5 sans contenu dupliqué plutôt que `content=`,
  mesuré dans `docs/DECISION-INDEX.md`.
- Livré en plus du cadrage initial : le mode lite dans ses deux transports, la commande
  `verify`, les codes d'erreur traçables, et le process de release.

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
