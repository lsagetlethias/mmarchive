# Cadrage du RAG

Mesuré sur l'archive réelle avant d'écrire la moindre ligne, comme pour l'index de
consultation. Les chiffres qui suivent viennent de l'index en place, pas d'ordres de
grandeur.

Le RAG est optionnel par construction et ne concerne que le mode full. Le mode lite tourne
dans un navigateur, sans serveur, sans clé d'API ni moteur d'inférence : rien ne doit l'y
contraindre.

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

Ce chiffre règle une question qu'on aurait pu croire structurante : ce n'est pas le prix
qui décidera entre un fournisseur distant et un moteur local.

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

**Recommandation : `bge-m3` en 1 024 dimensions, quantifié en entiers 8 bits.** 402 Mo de
vecteurs, un index total qui reste sous le gigaoctet et dont le RAG représente moins de la
moitié. La quantification divise par quatre pour une perte de rappel marginale, et si elle
se révélait sensible, repasser en flottants ne coûte qu'une reconstruction.

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

- **Le fournisseur.** Un moteur local ne fait pas sortir un million de messages internes de
  la machine qui héberge déjà l'archive ; un fournisseur distant les lui envoie. Le coût ne
  départage pas, la confidentialité si. À l'inverse, embarquer 92,2 M tokens sur un poste
  ordinaire se compte en heures ou en jours, là où une API le fait en une heure. L'interface
  compatible OpenAI permet de ne pas trancher dans le code, mais le défaut documenté est un
  choix en soi.
- **La règle de fenêtrage**, au vu de la médiane à 128 tokens.
- **La quantification**, à valider sur un échantillon plutôt que sur principe : mesurer le
  rappel en flottants et en entiers 8 bits sur une poignée de questions réelles.
- **Le recouvrement** au redécoupage, dont dépend la lisibilité des fils très longs.
