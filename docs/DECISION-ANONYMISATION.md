# Cadrage de l'anonymisation d'archive

« Anonymiser » n'est pas une case à cocher mais une promesse, et le seul cadrage honnête
consiste à dire jusqu'où elle tient.

Mesuré sur l'archive de référence avant d'écrire du code, comme l'index et le RAG l'ont été.

## Deux besoins qui n'appellent pas la même chose

Le premier est celui pour lequel `mmarchive-redact` a été écrit : **une personne demande
l'effacement de ses données**. On agit sur un compte désigné, les autres ne bougent pas.
C'est en place, et le contexte où l'archive reste entre les mains de l'organisation qui l'a
produite s'en accommode.

Le second est nouveau et change la nature du travail : **rendre une archive entière
diffusable**. Quand l'archive rassemble les canaux de plusieurs organisations, l'exigence
juridique peut être une anonymisation complète, y compris derrière une authentification.
Une authentification restreint qui entre ; elle ne change rien à ce que contient le fichier
une fois entré.

Ce document cadre le second. Il ne remplace pas le premier, qui reste la réponse aux
demandes individuelles.

## Ce que l'outil fait aujourd'hui, et pourquoi cela ne suffit pas

`redact --mode pseudonymize` remplace `user_id`, `username`, et les identités portées par
les métadonnées. **Il ne touche pas au texte des messages.** Un message disant
« @prenom.nom peux-tu regarder » ou « merci Alice » ressort intact.

Pour une demande individuelle, c'est discutable mais défendable : on efface ce qu'une
personne a écrit, pas ce que les autres ont écrit d'elle. Pour une archive présentée comme
anonyme, c'est rédhibitoire, et pire qu'une absence de traitement : cela donne une garantie
que le résultat ne tient pas.

## Ce que contient réellement l'archive

| Ce qui identifie                                    | Mesure                              |
| --------------------------------------------------- | ----------------------------------- |
| Messages citant un prénom ou nom d'un compte connu    | 515 760, soit 39,7 %                |
| Messages contenant une mention `@`                    | 215 658, soit 16,6 %                |
| dont mentions résolues vers un compte connu           | 244 280                             |
| dont mentions sans compte correspondant               | 91 812                              |
| Messages contenant une adresse électronique           | 41 960, soit 3,2 %                  |
| Messages ressemblant à un numéro de téléphone         | 2 903, soit 0,2 %                   |
| Pièces jointes dont le nom porte un nom de personne   | 2 452 sur 46 756                    |
| Canaux dont le nom porte un identifiant rare          | 57 sur 758                          |
| Avatars stockés                                       | 3 277                               |

Le chiffre qui commande tout est le premier. **Les noms écrits en clair sont vingt fois plus
nombreux que les mentions**, et c'est là que se joue la réussite ou l'échec. Il est
d'ailleurs surestimé : le comptage attrape des mots courants qui sont aussi des identités.

## Les décisions

**Pseudonymes lisibles et manifestement artificiels.** Nom de chose plus adjectif accordé,
`Obsidienne Discrete`, distribués depuis un hachage salé. Livré dans `redact/pseudonym.ts`.

Un générateur de noms réalistes a été écarté sur mesure : sur cette archive, trente prénoms
français très courants sont **tous** déjà portés par un compte. Attribuer les propos de
quelqu'un au nom d'une personne réelle est plus grave que de ne pas anonymiser, puisque cela
ne se contente pas de laisser fuir une identité, cela en fabrique une fausse.

**Le sel est tiré au hasard à chaque exécution et jeté.** Sans lui, un `sha256(user_id)` se
renverse en quelques secondes par qui détient la liste des identifiants de l'instance, soit
exactement le public dont on se protège.

**La correspondance n'est pas conservée.** La garder permettrait de ré-identifier plus tard,
et retirerait à l'archive son caractère anonyme ; ce fichier deviendrait la chose à ne
surtout pas perdre.

**Les mentions sont remplacées par le pseudonyme**, pas neutralisées : `@prenom.nom` devient
`@Obsidienne-Discrete`. Les fils restent lisibles, on continue de voir qui répond à qui,
ce qui est la valeur de l'archive.

Les 91 812 mentions sans compte correspondant ne peuvent pas être traduites. Elles sont
neutralisées, parce qu'une mention non résolue reste un nom.

**Les adresses électroniques deviennent `<redacted>`**, sans masquage partiel. Une forme du
type `li...@..m` reste identifiante quand on connaît la population : une initiale, une
longueur et un domaine suffisent souvent à retrouver quelqu'un dans une organisation. Le
masquage partiel a du sens pour une lecture interne, pas pour une diffusion contrainte.

**Les pièces jointes et les avatars sont supprimés**, pas renommés. Un nom de fichier porte
une identité, et une photo de visage plus sûrement encore.

**Les canaux personnels ne sont pas concernés** : ils sont privés, donc absents d'une archive
qui ne prend que des canaux publics.

**Les canaux publics dont le nom porte une identité ne sont pas renommés.** Ils existent, et
ce ne sont pas des canaux personnels : 57 sur 758 contiennent un identifiant porté par un ou
deux comptes seulement, dont 3 dont le nom se réduit à cela. Le premier comptage en trouvait
181, mais il attrapait des prénoms répandus employés comme mots ordinaires ; ne retenir que
les identifiants rares donne une mesure défendable.

Renommer coûterait plus que cela ne rapporte : les permaliens cassent, et l'archive cesse de
correspondre aux souvenirs de ceux qui l'ont vécue. Ces 57 canaux sont donc un **résidu
assumé**, et le rapport les nomme un par un.

C'est le cas qu'il faut connaître avant de diffuser, parce que le nom d'un canal ne se cache
nulle part : il figure dans la barre latérale, dans chaque permalien, et en tête de chaque
fragment produit par le RAG. Sur ces canaux, l'identité serait donc répétée dans tous leurs
fragments alors que tout le reste aurait été pseudonymisé. Les voir listés permet d'en
exclure ou d'en renommer quelques uns à la main, ce qui coûte moins qu'une règle
automatique.

## Le remplacement des noms en clair, et son revers

C'est la partie qui décide de la valeur du résultat, et la seule qui ne peut pas être exacte.

Le principe est de remplacer les prénoms et noms tirés des comptes connus par le pseudonyme
correspondant. Deux erreurs symétriques, et il faut choisir laquelle coûte le plus cher.

**Sous-remplacer laisse fuir une identité.** C'est l'échec qui compte, puisque c'est celui
qui fait mentir la promesse.

**Sur-remplacer abîme le texte.** 90 identifiants font moins de quatre lettres, et treize
mots courants du français sont aussi des noms de comptes ici : `pierre`, `rose`, `ange`,
`france`, `marine`, `aurore`, `clement`, `merle`. Sur un échantillon de 200 000 messages,
1,1 % contiennent l'un de ces mots dans un usage souvent ordinaire. Remplacer aveuglément
transformerait « une pierre angulaire » en « une Obsidienne Discrete angulaire ».

**L'arbitrage retenu privilégie l'anonymat.** Un texte un peu abîmé reste exploitable ; une
identité qui fuit ne se rattrape pas une fois l'archive diffusée. Le remplacement est donc
large, et c'est le rapport qui rend le coût visible.

## Le rapport des occurrences résiduelles

Aucun traitement automatique n'atteindra la totalité. Restent les noms mal orthographiés,
les surnoms, les initiales, les signatures, les personnes qui n'ont jamais eu de compte,
les identités contenues dans les images.

L'outil produit donc, à côté de l'archive, **un rapport de ce qu'il a fait et de ce dont il
doute** :

- ce qui a été remplacé, par catégorie et par volume ;
- les mentions non résolues et leur emplacement ;
- les motifs qui ressemblent à une identité sans correspondre à un compte : adresses,
  numéros, majuscules isolées suivant un mot comme « merci » ou « cc » ;
- les remplacements ambigus, ceux portant sur un mot également courant, pour qu'une
  relecture puisse les infirmer ;
- les canaux dont le nom porte une identité, qui ne sont pas renommés.

Ce rapport n'est pas un accessoire. Il est ce qui permet de dire à un juriste ce qui est
garanti et ce qui ne l'est pas, et il doit être lu avant diffusion, jamais archivé avec elle
puisqu'il désigne précisément ce qu'on a cherché à cacher.

## Ce que cela garantit, et ce que cela ne garantit pas

Est garanti : aucun identifiant, nom de compte, adresse électronique, mention résolue,
avatar ni pièce jointe ne subsiste, et la correspondance vers les identités d'origine
n'existe plus nulle part.

N'est pas garanti : qu'aucun nom ne subsiste dans le corps des messages, ni dans le nom des
canaux. Une personne désignée par un surnom, une initiale ou une orthographe approximative
passera au travers, et les canaux nommés d'après quelqu'un gardent leur nom.

C'est cette phrase, et non la commande, qu'il faut soumettre au juridique.

## Une commande distincte, pas un drapeau

L'anonymisation d'archive vit dans **`mmarchive-anonymize`**, à côté de `mmarchive-redact`,
et non derrière un `--all` ajouté à ce dernier.

Ce sont deux opérations que rien ne rapproche sinon leur mécanique. L'une honore la demande
d'une personne et laisse l'archive par ailleurs intacte ; l'autre réécrit tout, ne se défait
pas, et prépare une diffusion. Les loger sous le même verbe ferait qu'un drapeau oublié, ou
ajouté par erreur, transforme une opération ciblée en réécriture complète. Le jour où cela
arrive, la correspondance a déjà été jetée.

Deux noms distincts rendent la confusion impossible à commettre plutôt que rare.

## Ordre de construction

1. Les pseudonymes, distribués et salés. **Livré.**
2. `mmarchive-anonymize`, qui applique la pseudonymisation à tous les comptes, supprime les
   pièces jointes et les avatars.
3. La réécriture du texte : mentions résolues, mentions orphelines, adresses, numéros.
4. Le remplacement des noms en clair, la partie risquée, à mesurer sur un échantillon avant
   de l'appliquer à l'archive entière.
5. Le rapport, qui doit exister avant l'étape 4 pour que ses effets soient observables.

## Ce qui reste à trancher

- **Les numéros de téléphone**, 2 903 messages : mêmes deux modes que les adresses, ou
  suppression pure.
- **La réversibilité par recoupement.** Même sans noms, un fil daté, situé dans un canal
  identifiable, avec un enchaînement de réponses caractéristique, peut désigner quelqu'un
  pour qui connaît le contexte. Aucune pseudonymisation n'y répond, et il faut le dire
  plutôt que de laisser croire le contraire.
