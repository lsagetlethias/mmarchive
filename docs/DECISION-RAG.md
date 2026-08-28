# Cadrage du RAG

Mesuré sur l'archive réelle avant d'écrire la moindre ligne, comme pour l'index de
consultation. Les chiffres qui suivent viennent de l'index en place, pas d'ordres de
grandeur.

Le RAG est optionnel par construction et ne concerne que le mode full. Le mode lite tourne
dans un navigateur, sans serveur, sans clé d'API ni moteur d'inférence : rien ne doit l'y
contraindre.

Deux décisions sont prises et ne sont plus à débattre : **les embeddings sont calculés par
un service distant**, pas par un moteur local, et **le mode lite n'aura jamais de RAG**.

## Ce qu'il y a à traiter

| Grandeur                              | Mesure     |
| ------------------------------------- | ---------- |
| Messages indexés                      | 1 311 424  |
| Racines de fil                        | 502 500    |
| Réponses                              | 808 924    |
| Fils portant au moins une réponse     | 128 084    |
| Canaux                                | 699        |
| Texte brut                            | 245,5 M caractères |

## Ce que le découpage prescrit produit réellement

Le cahier des charges impose de découper par fil et jamais par message, avec une fenêtre
glissante hors fil coupée sur un écart de plus de trente minutes ou une quarantaine de
messages, pour une cible d'environ 800 tokens. Simulé sur l'archive :

| Grandeur                        | Mesure    |
| ------------------------------- | --------- |
| Fils                            | 128 084   |
| Fenêtres hors fil               | 231 661   |
| Fragments, avant redécoupage    | 359 745   |
| Fragments, après redécoupage    | 392 662   |
| Tokens à traiter                | 92,2 M    |
| Taille médiane d'un fragment    | 128 tokens |
| 90e centile                     | 495 tokens |
| 99e centile                     | 2 016 tokens |
| Fragments dépassant la cible    | 16 790, soit 4,7 % |

**La médiane est à 128 tokens, pas à 800.** C'est le résultat le plus important de cette
simulation, et il contredit l'intuition du cadrage. Le découpage par fil visait à éviter
les fragments illisibles hors contexte, du type d'un « +1 » isolé ; sur cette archive, il
en produit quand même en masse, parce que les fils sont courts et les conversations
éparses. La moitié des fragments tiennent en deux ou trois phrases.

Un corpus de 392 662 fragments dont la moitié est minuscule donne une recherche bruitée :
beaucoup de candidats qui ressemblent à la question sans rien en dire. Deux pistes à
arbitrer avant de coder, aucune ne demandant de changer de principe :

- élargir la fenêtre hors fil, la coupure à trente minutes étant manifestement trop courte
  pour ce rythme de conversation ;
- fusionner les fragments consécutifs d'un même canal jusqu'à approcher la cible, ce qui
  revient à traiter la cible comme un plancher et non comme un plafond.

À l'autre extrémité, le plus gros fragment avant redécoupage pèse 177 578 tokens : un fil
unique, très au delà des 8 192 tokens de contexte des modèles visés. Le redécoupage avec
recouvrement n'est donc pas un raffinement, c'est une nécessité.

## Le coût n'est pas le facteur limitant

Les modèles d'embedding de Scaleway sont facturés 0,12 dollar par million de tokens
d'entrée. Les 92,2 M tokens de cette archive coûtent donc **environ 11 dollars**, une fois,
puisque les vecteurs sont calculés une seule fois et stockés.

Ce chiffre aurait pu départager un fournisseur distant d'un moteur local ; il ne le fait
pas, et la question est de toute façon tranchée en faveur du distant.

## L'archive est francophone, ce qui n'autorise pas un modèle anglais

Mesuré sur 60 000 messages de plus de soixante caractères : **90 % de français**, 1,4 %
d'anglais, le reste indéterminé, l'essentiel étant des messages trop courts, du jargon ou
du code.

Il faut donc un modèle qui traite le français, et non un modèle couvrant cent langues. La
nuance a une conséquence contre-intuitive : chez les fournisseurs visés, **il n'existe pas
de modèle « français seulement »**, et les modèles les meilleurs en français sont
précisément ceux étiquetés multilingues. `bge-multilingual-gemma2` occupe la première place
en français au classement MTEB, devant des modèles anglophones bien plus connus.

Écarter un modèle sur son nom mènerait donc à choisir un modèle anglais, c'est à dire à
dégrader exactement ce qu'on cherche à préserver. Le critère est la performance en
français, pas le nombre de langues au catalogue.

## Ce qui décide vraiment : la taille des vecteurs

Deux modèles multilingues, deux dimensions très différentes, et c'est là que se joue la
faisabilité.

| Modèle                    | Dimensions | Vecteurs en flottants | En entiers 8 bits | Index total quantifié |
| ------------------------- | ---------- | --------------------- | ----------------- | --------------------- |
| `bge-multilingual-gemma2` | 3 584      | 5,63 Go               | 1 407 Mo          | 2,06 Go               |
| `bge-m3`                  | 1 024      | 1,61 Go               | 402 Mo            | 1,06 Go               |

L'index de consultation actuel pèse 656 Mo. Prendre `bge-multilingual-gemma2` en flottants
le ferait passer à plus de 6 Go, soit dix fois sa taille, pour une fonctionnalité déclarée
optionnelle.

Les deux modèles traitent le français. `bge-multilingual-gemma2` le traite mieux, et pèse
trois fois et demie plus lourd.

**Recommandation : commencer par `bge-m3` en 1 024 dimensions, quantifié en entiers 8
bits.** 402 Mo de vecteurs, un index total sous le gigaoctet dont le RAG représente moins
de la moitié, et une qualité en français déjà solide.

Ce choix n'engage à rien, et c'est ce qui le rend raisonnable : reconstruire avec un autre
modèle coûte onze dollars et une heure. La bonne façon de trancher entre les deux est donc
de mesurer le rappel sur une poignée de questions réelles, pas d'arbitrer sur un classement.

Une piste reste à vérifier avant de figer quoi que ce soit : les embeddings dits
*matryoshka* se laissent tronquer à leurs premières dimensions sans être recalculés, ce qui
permettrait de garder le meilleur modèle en réduisant l'index. La documentation du
fournisseur mentionne le procédé, mais je n'ai pas pu confirmer qu'il s'applique à ce
modèle précis. À vérifier sur la fiche du modèle, l'écart en jeu étant de 1 407 Mo à
302 Mo.

## Les vecteurs vivent dans un fichier séparé

C'est la conclusion structurante, et elle découle du mode lite.

La copie autonome pèse aujourd'hui 325 Mo compressés et s'ouvre en double-clic. Loger les
vecteurs dans le même fichier SQLite que l'index de consultation ferait entrer 402 Mo de
données strictement inutiles au lite dans chaque copie emportée, puisque le navigateur ne
peut ni interroger un fournisseur d'embeddings ni faire tourner un modèle.

Un fichier `vectors.db` distinct, attaché par `ATTACH` côté serveur quand le RAG est
activé, préserve les deux propriétés qui comptent : le lite reste dérivable du full sans
second pipeline, et une archive sans RAG ne paie rien pour lui.

## Ce qui reste à trancher

- **Le modèle**, entre qualité en français et taille d'index, à mesurer sur des questions
  réelles plutôt qu'à arbitrer sur un classement. La troncature matryoshka, si elle
  s'applique, rendrait l'arbitrage caduc.
- **La règle de fenêtrage**, au vu de la médiane à 128 tokens.
- **La quantification**, à valider sur un échantillon plutôt que sur principe : mesurer le
  rappel en flottants et en entiers 8 bits sur une poignée de questions réelles.
- **Le recouvrement** au redécoupage, dont dépend la lisibilité des fils très longs.
