# Cadrage du RAG

Mesuré sur l'archive réelle et documenté contre la littérature, avant d'écrire la moindre
ligne de code, comme l'index de consultation l'avait été.

Le RAG est optionnel par construction et ne concerne que le mode full. Deux décisions sont
prises et ne sont plus à débattre : **les embeddings sont calculés par un service distant**,
jamais par un moteur local, et **le mode lite n'aura jamais de RAG**, puisqu'il tourne dans
un navigateur incapable de tenir une clé d'API.

> **Trois conclusions de la première version de ce document ont été corrigées** après
> recherche documentaire. Elles sont signalées à leur place plutôt que réécrites en
> silence : le modèle recommandé, le diagnostic sur la taille des fragments, et la méthode
> de fusion. Se tromper en cadrant coûte moins cher que de se tromper en codant, à
> condition de le dire.

## Comment ces chiffres ont été obtenus

Tout ce qui concerne l'archive vient de son index de consultation, interrogé directement.

Le découpage a été **simulé** en parcourant les messages par canal dans l'ordre
chronologique, en groupant chaque racine avec ses réponses, et en coupant les fenêtres hors
fil sur un écart de plus de trente minutes ou au-delà de quarante messages, exactement
comme le cahier des charges le prescrit. Chaque message se voit ajouter quarante caractères
pour l'en-tête « auteur : » et chaque fragment cent vingt pour son en-tête de contexte.

Les chiffres ci-dessous ne viennent plus d'un script jetable mais de la commande
`mmarchive-index plan-chunks`, qui applique le découpage réel et compte le texte
effectivement produit, en-têtes compris. Elle parcourt l'archive en flux et rend son rapport
en une quinzaine de secondes, ce qui permet de comparer deux réglages plutôt que de
raisonner sur un seul.

Deux erreurs des mesures précédentes sont corrigées au passage. La première détectait les
racines de fil en chemin, à la première réponse rencontrée ; le parcours étant
chronologique, toute racine passait avant ses réponses et se retrouvait comptée à la fois
comme fenêtre et comme fil, ce qui gonflait le total d'un quart. La seconde estimait la
taille des en-têtes au lieu de les écrire, et surévaluait donc le volume de texte.

Trois approximations à connaître :

- **La conversion en tokens suppose 3,7 caractères par token**, ratio usuel pour du
  français. Le tokenizer réel du service retenu donnera un résultat différent. L'écart joue
  sur le budget, pas sur les conclusions.
- **Le nombre de fragments après redécoupage est une borne basse**, calculée sans
  recouvrement.
- **La répartition linguistique est une heuristique**, comptage de mots-outils fréquents sur
  60 000 messages de plus de soixante caractères. Bon pour un ordre de grandeur, pas pour
  une statistique fine.

Un point de vocabulaire à fixer, parce qu'il induit en erreur : **1 311 424 est le nombre de
messages retenus dans l'index**, après écartement de 581 367 messages système et de bots.
Le total extrait est de 1 892 791. Les 581 367 écartés représentent donc 31 % du total
extrait, et non 44 % des messages indexés. Tout budget d'embedding se calcule sur 1 311 424.

## Ce qu'il y a à traiter

| Grandeur                          | Mesure             |
| --------------------------------- | ------------------ |
| Messages retenus dans l'index     | 1 311 424          |
| Messages système et bots écartés  | 581 367            |
| Racines de fil                    | 502 500            |
| Réponses                          | 808 924            |
| Fils portant au moins une réponse | 128 084            |
| Canaux                            | 699                |
| Texte brut                        | 245,5 M caractères |
| Français                          | 90 %, contre 1,4 % d'anglais |

## Le découpage, et pourquoi mon premier diagnostic était faux

Simulation de la règle prescrite :

| Grandeur                     | Mesure         |
| ---------------------------- | -------------- |
| Fragments                    | 297 515        |
| dont issus de fils           | 141 433        |
| dont issus de fenêtres       | 156 082        |
| Tokens à traiter             | 79,3 M         |
| Médiane                      | 145 tokens     |
| Moyenne                      | 266 tokens     |
| 90e centile                  | 667 tokens     |
| 99e centile                  | 1 579 tokens   |
| Plus gros fragment           | 4 456 tokens   |

Les deux premières lignes comptent des fragments, pas des fils : un fil trop long en produit
plusieurs. Le plus gros fragment est un message unique dépassant à lui seul le plafond, que
le découpage garde entier plutôt que de le trahir en le coupant.

L'effet du réglage se lit directement, ce pour quoi la commande existe :

| Coupure    | Fragments | Médiane    |
| ---------- | --------- | ---------- |
| 10 minutes | 327 369   | 127 tokens |
| 30 minutes | 297 515   | 145 tokens |
| 2 heures   | 257 698   | 179 tokens |

Le volume de tokens, lui, ne bouge quasiment pas, de 79,8 à 78,5 M : le texte est le même,
seul son groupement change. Le réglage déplace donc la forme de la distribution, pas le
coût.

**La première version de ce document concluait qu'une médiane courte, loin des 800 tokens
visés, produirait une recherche bruitée. La littérature dit le contraire.**

Cirillo et al. mesurent le nDCG@10 par taille de fragment sur six encodeurs et concluent :
*« All models attain at least 95% of their peak nDCG@10 performance by a chunk size of 32
tokens and exhibit no further gains at 64 or 128 tokens »*. Une médiane à 145 tokens est
donc plus de quatre fois au-dessus du seuil de saturation, pas en dessous d'un seuil de qualité.
Bhat et al. vont dans le même sens : 64 à 128 tokens est l'optimum documenté pour des
questions factuelles, les fragments longs ne servant que les questions de synthèse.

Le vrai mécanisme de dégradation est ailleurs, et les auteurs du *late chunking* le nomment
précisément : la perte de référent. Un fragment de chat du genre « ok je prends » ou « +1
pour la v2 » n'a aucun antécédent nommable, le sujet vivant dans le nom du canal, dans le
message racine, ou trois messages plus haut. **C'est là qu'il faut investir, pas dans
l'allongement des fragments.**

Deux corrections concrètes à la règle, elles bien étayées :

- **Le plafond de quarante messages ne se déclenche pratiquement jamais**, mesuré en
  comptant les causes de fermeture : **1,0 % ferment sur le plafond, 98,6 % sur la coupure
  des trente minutes**, le reste en fin de canal. C'est donc la
  coupure temporelle qui pilote tout, et elle seule mérite d'être réglée. Les seuils publiés
  en désenchevêtrement de conversation vont de 129 secondes à une heure, un facteur 28 :
  aucun consensus n'existe, et trente minutes est défendable sans être validé.
- **Le vrai signal de structure est `root_id`, pas l'horloge.** La pratique industrielle sur
  Slack converge sur le fil comme unité. La fenêtre temporelle ne doit servir que de recours
  pour les canaux non threadés.

Sur le **recouvrement**, les deux seules études contrôlées trouvées concluent à un bénéfice
nul. Bennani et Moslonka : *« overlap provides no measurable benefit and increases indexing
cost »*. Chroma mesure que la configuration à 50 % de recouvrement produit les pires scores.
La règle des 10 à 20 % répandue en ingénierie n'a aucune base expérimentale identifiée, et
le défaut de LlamaIndex est à 2 %. Comme nos frontières de fil sont naturelles et non
arbitraires, **partir à zéro recouvrement** et ne l'introduire que si une mesure le
justifie.

Le redécoupage reste donc une nécessité, même sans recouvrement, ne serait-ce que pour les
fils très longs : sans lui, le plus gros groupe atteindrait 177 578 tokens, très au-delà du
contexte de tous les modèles visés.

## Le modèle : le catalogue réel dément la première recommandation

**La première version recommandait `bge-m3`. Ce modèle n'est pas au catalogue de Scaleway.**
Le fournisseur n'expose que deux modèles d'embedding actifs.

| Modèle                    | Dimensions             | Contexte | Prix, entrée | Débit maximal     | Licence    |
| ------------------------- | ---------------------- | -------- | ------------ | ----------------- | ---------- |
| `qwen3-embedding-8b`      | 32 à 4 096, matryoshka | 32k      | 0,10 EUR/M   | 1 000k tokens/min | Apache 2.0 |
| `bge-multilingual-gemma2` | 3 584, figées          | 8k       | 0,10 EUR/M   | 400k tokens/min   | Gemma      |

Un troisième, `sentence-t5-xxl`, est en fin de vie depuis février 2025.

**Recommandation : `qwen3-embedding-8b`.** Elle ne tient pas à un classement mais à quatre
propriétés mesurables. Il accepte des dimensions réduites là où l'autre est figé à 3 584. Il
encaisse un débit deux fois et demie supérieur, ce qui ramène l'indexation complète à
environ 80 minutes contre plus de trois heures. Son contexte de 32k absorbe les fils longs
là où 8k les découperait. Et sa licence Apache 2.0 convient à un outil destiné à être
republié, ce qui n'est pas évident avec la licence Gemma.

Un mot sur l'argument qui m'avait égaré : la documentation de Scaleway présente
`bge-multilingual-gemma2` comme premier en français au classement MTEB, **en datant
elle-même cette affirmation du quatrième trimestre 2024**. Elle a deux ans. La même page
donne `qwen3-embedding-8b` troisième en novembre 2025. Reprendre le premier chiffre sans
sa date aurait été malhonnête.

Le prix ne départage rien : les deux modèles sont au même tarif, et **l'API Batches supprime
toute limite de débit avec 50 % de remise**. La passe complète revient à **7,93 EUR en
synchrone, 3,96 EUR en batch**. Le premier million de tokens est offert.

Une contradiction à lever avant de coder : la FAQ de Scaleway recommande d'utiliser
`qwen3-embedding-8b` en 2 000 dimensions, tandis que la page de référence de l'API liste
`dimensions` parmi les paramètres non supportés. **À tester contre l'API réelle.** Si le
paramètre est refusé, la troncature reste faisable côté client, mais on paie et on transfère
4 096 flottants par fragment.

## Ce qu'implique d'envoyer l'archive à un tiers

Le choix du calcul distant est acté, mais il n'est pas neutre et le document ne peut pas se
contenter de l'acter. **79,3 M tokens d'échanges internes sortiront de la machine qui les
héberge.** Un projet qui refuse les joins implicites et n'écoute que la boucle locale ne
peut pas traiter ce transfert comme un détail d'implémentation.

Quatre points à établir avec le fournisseur retenu, et à écrire dans la documentation
d'exploitation avant la première indexation :

- **La conservation.** Combien de temps le contenu soumis est-il gardé, et à quelle fin ?
  Un fournisseur qui journalise les entrées pour deux mois conserve deux mois d'archive.
- **La réutilisation pour l'entraînement.** Elle doit être exclue contractuellement, pas
  seulement absente des mentions commerciales.
- **La région de traitement.** Scaleway annonce `fr-par` pour ces modèles, ce qui est un
  argument de choix autant que la qualité.
- **Le contrat de sous-traitance.** L'archive contient des données personnelles au sens du
  règlement, ne serait-ce que les noms et les propos de personnes identifiables. Un accord
  de sous-traitance est nécessaire, et l'analyse d'impact éventuelle relève de
  l'organisation qui exploite l'archive, pas de cet outil.

Deux atténuations sont à portée et méritent d'être décidées en même temps que le
fournisseur. **N'indexer qu'un sous-ensemble de canaux** limite mécaniquement ce qui sort,
et le RAG étant optionnel, l'indexation partielle doit l'être aussi. **Passer l'archive par
`mmarchive-redact`** avant indexation, pour les personnes ayant demandé un effacement,
évite d'envoyer chez un tiers ce qu'on a déjà accepté d'effacer chez soi.

Rien de tout cela n'est du code, et c'est pour cette raison que ça doit figurer ici : ce
sont des décisions à prendre avant d'écrire la première ligne, pas après.

## La taille des vecteurs, et une bonne surprise sur la troncature

Sur 297 515 fragments, en flottants : 4,87 Go en 4 096 dimensions, 4,27 Go en 3 584,
2,38 Go en 2 000, 1,22 Go en 1 024, 0,91 Go en 768, 0,30 Go en 256. En entiers 8 bits,
diviser par quatre. L'index de consultation pèse 656 Mo.

La troncature réserve un résultat contre-intuitif. On croit couramment qu'elle exige un
modèle entraîné en matryoshka ; Takeshita et al. mesurent que **la troncature simple tient
jusqu'à environ 80 % de réduction, y compris sur des modèles non entraînés ainsi**. Passer
de 3 584 à 1 024 représente 71,4 % de troncature, donc sous le seuil. Matryoshka ne devient
un critère de sélection que sous 256 dimensions.

**Cible : 1 024 dimensions, quantifiées en entiers 8 bits, soit 305 Mo de vecteurs**, ce qui
porte l'ensemble à 961 Mo contre 656 aujourd'hui. En 2 000 dimensions, la valeur que
recommande la FAQ du fournisseur, les vecteurs pèsent 595 Mo et l'ensemble 1,25 Go. À
valider sur un échantillon plutôt qu'à décider sur principe.

## Le stockage : `sqlite-vec` tient, vérifié

- **Il se charge dans `node:sqlite`**, vérifié par test sur plusieurs versions de Node 24 :
  `new DatabaseSync(path, { allowExtension: true })` puis `load(db)`. Le projet n'a pas à
  revenir sur sa décision d'écarter `better-sqlite3`.
- **Ce n'est pas un module natif compilé** : pas de `node-gyp`, pas de `.node`, pas de
  rebuild par version de Node. Un binaire préconstruit, chargé à l'exécution.
- **Aucun binaire pour linux-musl.** L'image doit rester sur une base glibc. C'est déjà le
  cas, `node:24-slim` étant Debian, mais cela devient une contrainte à ne pas oublier.
- Licence MIT ou Apache 2.0, deux millions de téléchargements hebdomadaires.
- **Toujours pré-v1** en version 0.1.9, avec des ruptures annoncées, un mainteneur unique et
  trois mois sans commit. Épingler la version exacte et accepter que le schéma vectoriel
  puisse devoir être reconstruit. Le risque est tenable parce que l'index est dérivé : le
  perdre ne coûte qu'une reconstruction.

## La fusion : la troisième correction

Le cahier des charges prescrit une fusion par rang réciproque. **Deux mesures indépendantes
montrent que ce n'est pas le meilleur choix pour fusionner deux listes.**

RRF a été conçu et validé pour fusionner beaucoup de systèmes, trente configurations dans
l'article d'origine. Bruch et al. comparent RRF à une combinaison convexe de scores
normalisés et concluent que celle-ci gagne systématiquement de 0,015 à 0,032 point de nDCG,
ajoutant que *« RRF is sensitive to its parameters »* et qu'*« a tuned RRF generalizes
poorly to out-of-domain datasets »*. OpenSearch mesure le même écart, environ 4 %.

**Retenir une combinaison convexe**, avec un poids de 0,6 à 0,8 sur le vectoriel comme point
de départ étayé. Elle impose une contrainte d'implémentation qu'on rate souvent : il faut un
score des deux côtés, donc un document trouvé par un seul moteur doit se voir attribuer un
score dans l'autre, pas être écarté.

Si RRF est malgré tout retenu pour sa simplicité, la constante `k` ne mérite aucun réglage :
entre 20 et 100, le MAP varie de 0,6 % dans l'article d'origine.

Un avertissement enfin : **l'hybride n'est pas gratuit**. Sur une tâche de paraphrase, le
vectoriel seul fait 0,8256 de nDCG@10 contre 0,7960 pour l'hybride, soit 3,6 % de moins.
Injecter du lexical dégrade les requêtes purement conceptuelles.

## Architecture

### Où le code vit

```text
packages/viewer/src/rag/
  config.ts        lecture de la configuration, et rien d'autre
  chunk.ts         découpage en fragments, fonction pure
  chunk-store.ts   écriture des fragments et de leurs métadonnées
  embed.ts         client d'embeddings derrière une interface
  vectors.ts       stockage et recherche des vecteurs
  fusion.ts        combinaison des deux classements, fonction pure
  retrieve.ts      orchestration de la recherche hybride
  generate.ts      appel du modèle de génération, en flux
packages/viewer/src/server/rag-routes.ts
```

`chunk.ts` et `fusion.ts` sont des fonctions pures, sans accès disque ni réseau. C'est
délibéré : ce sont les deux endroits où la qualité se joue, et les deux qui se testent
exhaustivement sans dépendre d'un fournisseur.

### Le RAG ne s'installe que s'il est demandé

Les routes ne sont montées que si la configuration l'active, et `/api/meta` expose un
drapeau que le frontend lit pour afficher ou non l'entrée « Assistant ». Sans configuration,
rien n'est chargé, rien n'est servi, et l'absence du fichier de vecteurs n'est pas une
erreur. Le chargement de l'extension vectorielle suit la même règle : un viewer ordinaire
n'ouvre jamais cette porte.

### Le fichier de vecteurs est attaché, pas fusionné

`vectors.db` reste distinct, attaché par `ATTACH DATABASE` quand le RAG est actif. Une seule
connexion sert les deux, ce qui permet de joindre fragments et messages sans aller-retour
applicatif, tout en gardant les fichiers séparables.

C'est ce qui fait qu'une archive emportée reste à 325 Mo et qu'une archive sans RAG ne paie
rien pour lui.

### Ce qui n'est pas isomorphe, et pourquoi c'est correct

La couche de requêtes du viewer est synchrone et isomorphe, pour que le même code tourne
dans Node et dans le worker du navigateur. Le RAG y échappe : il est asynchrone par nature
et ne tourne que côté serveur. Le faire passer par `SqlDriver` contaminerait la couche
isomorphe avec de l'asynchrone dont le mode lite n'a que faire.

### Ordre de construction

1. `chunk.ts` et une commande de simulation qui compte fragments, tokens et coût sans rien
   appeler. C'est l'outil qui sert à régler la coupure temporelle.
2. `chunk-store.ts` et le schéma des fragments, qui n'a pas besoin des vecteurs.
3. La moitié lexicale de la recherche hybride. La recherche actuelle trie par date et
   n'expose aucun score : il faut une variante classée par `bm25()`.
4. `fusion.ts`, testable avec deux listes fabriquées.
5. Le reste, qui attend la dimension : table vectorielle, calcul des vecteurs, génération.

Les quatre premières étapes ne dépendent d'aucun choix de modèle.

## Ce qui reste à trancher, et comment

Aucune des questions ouvertes ne se tranche par la lecture. Toutes demandent un jeu de
requêtes de référence construit sur cette archive, ce qui est le vrai premier livrable de la
phase de mesure.

- **La coupure temporelle**, seule variable qui pilote réellement le découpage.
- **La dimension retenue**, entre 1 024 et 2 000, et la quantification, à mesurer sur le
  rappel plutôt qu'à décider sur principe.
- **Le paramètre `dimensions` de l'API**, dont la documentation se contredit.
- **La méthode de fusion et son poids**, sachant que l'hybride peut dégrader les requêtes
  conceptuelles.
- **L'écartement des messages système et de bots.** Aucune étude ne mesure cet effet : c'est
  un trou de la littérature, pas un défaut de recherche. La seule source qui nomme les
  messages système comme du bruit le fait qualitativement. Trancher demande de construire
  deux index sur un canal représentatif et de comparer.
- **La contextualisation des fragments**, la piste la plus prometteuse au vu du diagnostic
  sur la perte de référent, mais dont le chiffrage publié suppose des fragments six fois
  plus gros que les nôtres. Un préfixe de 50 à 100 tokens sur un fragment de 128 noierait le
  contenu. À condenser fortement : nom du canal, participants, sujet du fil en une ligne.

Deux mises en garde tirées de la recherche. Remplacer un fragment par son résumé effondre
les performances, mesuré : toute contextualisation doit **ajouter** au fragment, jamais le
remplacer. Et les gains du *late chunking* comme du *contextual retrieval* ne se reproduisent
pas systématiquement en évaluation indépendante ; ce ne sont pas des achats sur catalogue.

## Limites de cette recherche

- **Aucune mesure trouvée sur du français.** Tous les seuils cités viennent de corpus
  anglais ou italien. La transposition est plausible, pas démontrée. `MTEB-French` et
  `NanoBEIR-fr` offrent un moyen bon marché de vérifier avant de s'engager.
- **Aucune mesure sur un journal de conversation d'entreprise réel.** Les corpus de
  référence sont des dialogues à deux participants, loin d'un canal multi-participants sur
  plusieurs années.
- **Aucune mesure de recherche hybride sur ce type de corpus** non plus.
- Le coût du *contextual retrieval* sur cette archive est indéterminable à distance : le
  chiffre publié repose sur un modèle retiré et sur des fragments six fois plus gros.

## Sources

Fournisseur et modèles :

- <https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/>
- <https://www.scaleway.com/en/pricing/model-as-a-service/>
- <https://www.scaleway.com/en/docs/generative-apis/api-cli/using-embeddings-api/>
- <https://docs.mistral.ai/capabilities/embeddings/text_embeddings>

Troncature et dimensions :

- Kusupati et al., *Matryoshka Representation Learning*, <https://arxiv.org/abs/2205.13147>
- Takeshita et al., <https://arxiv.org/abs/2605.16608>

Découpage :

- Cirillo et al., <https://arxiv.org/html/2605.23618>
- Bhat et al., <https://arxiv.org/abs/2505.21700>
- Günther et al., *Late Chunking*, <https://arxiv.org/abs/2409.04701>
- Merola et Singh, <https://arxiv.org/html/2504.19754v1>
- Pan et al., *SeCom*, <https://arxiv.org/abs/2502.05589>
- Xu et al., *MemGAS*, <https://arxiv.org/html/2505.19549v2>
- Bennani et Moslonka, <https://arxiv.org/abs/2601.14123>
- Chroma, *Evaluating chunking*, <https://www.trychroma.com/research/evaluating-chunking>
- Anthropic, *Contextual retrieval*, <https://www.anthropic.com/engineering/contextual-retrieval>
- Kummerfeld et al., <https://arxiv.org/abs/1810.11118>
- Snyk, <https://snyk.io/articles/from-slack-threads-to-structured-knowledge-implementing-rag-at-snyk/>

Fusion :

- Cormack, Clarke et Büttcher, *Reciprocal Rank Fusion*, ACM SIGIR 2009
- Bruch, Gai et Ingber, <https://arxiv.org/abs/2210.11934>

Évaluation en français :

- Lyon-NLP, *MTEB-French*, <https://arxiv.org/html/2405.20468>
- CATIE-AQ, *NanoBEIR-fr*, <https://huggingface.co/datasets/CATIE-AQ/NanoBEIR-fr>

La capacité de `node:sqlite` à charger une extension et le chargement effectif de
`sqlite-vec` ont été vérifiés par exécution, non par lecture de documentation.
