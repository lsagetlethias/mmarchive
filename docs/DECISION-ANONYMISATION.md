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
| Mentions `@`, en occurrences                          | 336 092                             |
| dont résolues vers un compte connu                    | 244 280                             |
| dont sans compte correspondant                        | 91 812                              |
| Messages contenant une adresse électronique           | 41 960, soit 3,2 %                  |
| Messages ressemblant à un numéro de téléphone         | 2 903, soit 0,2 %                   |
| Pièces jointes dont le nom porte un nom de personne   | 2 452 sur 46 756                    |
| Canaux dont le nom porte un identifiant rare          | 23 sur 758                          |
| Avatars stockés                                       | 3 277                               |
| Emojis personnalisés, souvent des visages             | 762                                 |
| Messages portant des métadonnées `props`              | 1 185 241, soit 62,6 %              |
| dont identifiants de comptes en clair dans `props`    | 24 151 sur six clés                 |
| dont noms de comptes en clair dans `props`            | 76 830                              |
| Messages dont le corps entier vit dans `props`        | 312 183, soit 16,5 %                |

Les cinq dernières lignes ne figuraient pas au premier cadrage, et elles changent la mesure
du travail. Les pourcentages du haut du tableau portent sur les 1 311 424 messages écrits par
des humains, alors que l'archive en compte 1 892 791. Les 581 367 qui manquent sont les
messages système et ceux déposés par des intégrations, c'est-à-dire précisément ceux dont
l'identité ne vit pas dans le champ `message`.

**`props` est une surface textuelle du même ordre que le corps des messages**, et rien dans
le schéma ne la contraint : c'est un `z.record(z.unknown())` recopié tel quel depuis l'API.
On y compte 969 296 champs de texte et 857 938 paires libellé/valeur, contre 1 892 791
messages.

Le chiffre qui commande tout est le premier. **Les messages citant un nom en clair sont deux
fois et demie plus nombreux que ceux qui portent une mention**, et c'est là que se joue la
réussite ou l'échec. Il est d'ailleurs surestimé : le comptage attrape des mots courants qui
sont aussi des identités.

## Les décisions

**Pseudonymes lisibles et manifestement artificiels.** Nom de chose plus adjectif accordé,
`Anon-Obsidienne-Discrete`, distribués depuis un hachage salé. Livré dans
`packages/extractor/src/redact/pseudonym.ts`.

Un générateur de noms réalistes a été écarté sur mesure : sur cette archive, trente prénoms
français très courants sont **tous** déjà portés par un compte. Attribuer les propos de
quelqu'un au nom d'une personne réelle est plus grave que de ne pas anonymiser, puisque cela
ne se contente pas de laisser fuir une identité, cela en fabrique une fausse.

La forme nom plus adjectif n'y suffisait pas : mesurée sur le vocabulaire retenu, **une
combinaison sur six se lisait encore comme une identité**, « Jade Humble », « Ambre
Fertile », plusieurs noms de choses étant aussi des prénoms. Écarter ces mots un par un
reviendrait à tenir une liste de prénoms, donc à se tromper un jour sur un prénom rare. Le
préfixe `Anon-` règle la question par la forme : aucun état civil ne s'écrit ainsi, et le
lecteur le voit à chaque ligne au lieu de l'oublier au bout de dix minutes.

**Le sel est tiré au hasard à chaque exécution et jeté.** Sans lui, un `sha256(user_id)` se
renverse en quelques secondes par qui détient la liste des identifiants de l'instance, soit
exactement le public dont on se protège.

**La correspondance n'est pas conservée.** La garder permettrait de ré-identifier plus tard,
et retirerait à l'archive son caractère anonyme ; ce fichier deviendrait la chose à ne
surtout pas perdre.

**Les mentions sont remplacées par le pseudonyme**, pas neutralisées : `@prenom.nom` devient
`@Anon-Obsidienne-Discrete`. Les fils restent lisibles, on continue de voir qui répond à qui,
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
ce ne sont pas des canaux personnels : **23 sur 758** portent, dans leur `name` ou leur
`display_name`, un jeton d'au moins quatre caractères qui est le nom d'utilisateur, le
prénom, le nom ou le surnom d'un ou deux comptes seulement.

Ce chiffre en remplace deux autres, et la correction vaut d'être écrite puisque c'est cette
section qu'un juriste lit. Le premier comptage en trouvait 181, mais attrapait des prénoms
répandus employés comme mots ordinaires. Le second annonçait 57, et **n'est pas
reproductible** : avec la définition ci-dessus, aucun réglage du seuil de rareté ni de la
longueur minimale du jeton ne dépasse 44, et 23 avec les valeurs retenues. C'est l'outil qui
produit désormais ce chiffre, à chaque exécution, plutôt qu'une mesure faite une fois à la
main.

Renommer coûterait plus que cela ne rapporte : les permaliens cassent, et l'archive cesse de
correspondre aux souvenirs de ceux qui l'ont vécue. Ces 23 canaux sont donc un **résidu
assumé**, et le rapport les nomme un par un.

C'est le cas qu'il faut connaître avant de diffuser, parce que le nom d'un canal ne se cache
nulle part : il figure dans la barre latérale, dans chaque permalien, et en tête de chaque
fragment produit par le RAG. Sur ces canaux, l'identité serait donc répétée dans tous leurs
fragments alors que tout le reste aurait été pseudonymisé. Les voir listés permet d'en
exclure ou d'en renommer quelques uns à la main, ce qui coûte moins qu'une règle
automatique.

**L'archive source n'est jamais modifiée.** `--out` est obligatoire. Ce n'est pas un
confort : le sel est jeté, donc une passe interrompue en place laisserait une archive dont
les binaires ont disparu, dont les identités sont intactes, et qu'aucun contrôle ne
distinguerait d'un résultat abouti. Avec une sortie séparée, un échec se solde en jetant la
sortie. La copie coûte peu, mesurée : 27 Go en entrée, 1,1 Go en sortie, puisque ce sont
précisément les binaires qui ne sont pas repris.

La contrepartie est qu'une passe interrompue laisse une sortie partielle, et que **c'est à
l'opérateur de la supprimer**. La commande ne la nettoie pas d'elle-même : un processus tué
ne nettoie rien de toute façon, et effacer un répertoire au premier échec ferait disparaître
ce qu'il faut regarder pour comprendre. Le marqueur `anonymized` du manifeste n'étant écrit
qu'en toute fin de passe, une sortie partielle ne le porte pas, et `--force` refuse alors de
la remplacer : il ne réécrit qu'une archive anonymisée complète, jamais un répertoire
quelconque ni le reliquat d'une passe interrompue.

**Les identifiants de comptes sont tirés au hasard, pas dérivés.** Une dérivation, même
salée, laisserait une correspondance reconstituable par qui retrouverait le sel ; un tirage
n'a rien à retrouver. Ils gardent la forme d'un identifiant Mattermost, 26 caractères
`[a-z0-9]`, parce que le format l'impose et qu'un identifiant lisible ferait échouer toute
relecture. Le pseudonyme lisible va dans `first_name`, sa forme minuscule dans `username`,
puisque la colonne correspondante de l'index n'a pas de `COLLATE` et que la recherche
`from:` y est sensible à la casse.

**`props` est réduit par liste blanche, et non nettoyé par liste noire.** Deux mesures
l'imposent. La clé `attendents`, mal orthographiée par un plugin de réunion, porte seize
noms de comptes : aucune liste noire écrite à l'avance ne l'aurait attrapée. Et `ended_by`
est polymorphe, elle porte un identifiant dans trois cas et un nom dans sept, donc le
traitement doit regarder la valeur et pas seulement la clé.

**Le texte des blocs `attachments` est conservé.** Le vider aurait été plus simple, et
invisible, puisque le viewer ne rend jamais `props`. Mais 312 183 messages ont un champ
`message` vide et tout leur corps là : les vider effacerait 16,5 % du corpus au motif que
le viewer d'aujourd'hui ne les affiche pas, ce qui inverse le rapport entre l'archive, qui
est la donnée durable, et le viewer, qui est jetable. Ce texte porte encore des noms et
rejoint donc le lot de la réécriture. Ce qui désigne, en revanche, part tout de suite :
`author_name` et les champs en `_link`, `_url` et `_icon`.

**Une référence qui ne résout vers aucun compte est retirée, jamais conservée.** Sur
l'archive de référence, 156 identifiants portés par des messages système et par des emojis
ne correspondent à aucune fiche, parce que le compte a été supprimé de l'instance ou que sa
récupération a échoué. Un repli du type `table.get(x) ?? x` les laisserait intacts.

**Le manifeste perd l'URL de l'instance, l'identité de l'opérateur et le détail des
avertissements.** `extracted_by` nomme en clair celui qui a lancé l'extraction, dans le
document que tout lecteur ouvre en premier ; `warnings[].detail` est de la prose d'erreur
interpolée avec des noms de comptes et de fichiers, qu'on ne réécrit pas sainement, alors
que le code et le décompte suffisent à auditer ce qui manque. Le nom de la team reste : on
ne prétend pas cacher l'organisation, et le rapport le nomme comme principal facteur de
recoupement restant.

**`.extract-state.json` n'est pas repris.** Son champ `fetched_user_ids` porte la liste
exhaustive des comptes rencontrés, soit exactement ce que l'anonymisation vient de
remplacer partout ailleurs.

**Les emojis personnalisés perdent leur image.** Le cadrage ne les mentionnait pas, alors
que l'argument qui a fait supprimer les avatars, une photo de visage identifie plus sûrement
qu'un nom, s'y applique mot pour mot. Les 762 lignes sont conservées, seule l'image est
annulée : en retirer ferait diverger `counts.emojis`, que la vérification compare.

## La table de correspondance écrite à côté de la question

Le défaut le plus grave rencontré sur cette commande, trouvé après sa livraison, et qui
mérite d'être écrit parce qu'il se reproduira.

Un message système porte un texte généré par Mattermost : « alice a été ajouté au canal par
bob ». Ce texte n'était pas touché, alors que `props` et `user_id` de la même ligne étaient
pseudonymisés. Une seule ligne appariait donc l'identité réelle et son substitut, **sans
avoir besoin de l'archive source**. Mesuré : 64 648 messages, exposant 3 206 comptes sur
3 277, soit 97,8 %. Le sel jeté ne protège de rien quand la réponse est écrite à côté de la
question.

La correction se fait en deux temps, du plus sûr au moins sûr. D'abord le nom lu dans
`props`, qui le porte nommément : aucune heuristique, aucun faux positif possible. Ensuite,
sur les seuls messages système, tout jeton d'au moins quatre caractères qui est un nom de
compte connu. Ce second temps est nécessaire parce qu'un compte ayant changé de nom laisse
un message figé sur l'ancien, que `props` ne nomme plus : « @julien a rejoint le canal » à
côté d'un `props.username` valant « julien.dauphant ». Il peut se tromper sur un nom
d'utilisateur qui serait aussi un mot ordinaire, et c'est l'arbitrage assumé plus bas.

Mesuré après correction : **zéro**.

Second défaut de la même famille, plus discret. Les fiches de comptes sortaient dans l'ordre
de la source, ligne pour ligne : un `paste` entre les deux fichiers rendait la table
complète à qui détient l'archive d'origine. Elles sortent désormais dans l'ordre de leur
identifiant de substitution, tiré au hasard. La promesse est que la correspondance n'existe
nulle part, pas qu'elle soit pénible à reconstituer.

## Le contrôle des identités résiduelles

`mmarchive-verify` **ne vérifie rien de l'anonymat**, et le croire est le risque principal.
Il ne confronte jamais `reactions[].user_id`, `files.user_id` ni `emojis.creator_id` à
l'annuaire, il ne regarde jamais `props`, et son contrôle des binaires ne parcourt que
`files.ndjson`, donc ignore les avatars. Une archive dont les 433 442 réactions auraient
gardé leurs identifiants réels passerait la vérification sans un seul avertissement.

D'où un contrôle dédié, qui relit l'archive produite et fait échouer la commande. Il est
**positif** sur les références : une valeur en position de référence doit appartenir à
l'ensemble des identifiants de substitution. Le formuler en négatif, en cherchant les
identifiants d'origine, laisserait passer les 156 qui ne résolvaient vers aucun compte,
c'est-à-dire exactement les plus faciles à oublier.

Il énumère aussi ce qu'il ne couvre pas, et la commande l'affiche. Un contrôle qui tairait
ses limites serait pire que pas de contrôle, puisqu'il ferait croire l'archive diffusable.

## La réécriture des formes ancrées

Toute la sûreté de cette étape vient de l'ancrage. Une mention commence par un arobase, une
adresse porte un arobase et un domaine, un identifiant fait vingt-six caractères. Rien n'est
deviné à partir d'un mot ordinaire, ce qui explique qu'elle puisse être large là où l'étape
suivante devra être prudente.

**Une seule passe, une alternation ordonnée, un branchement sur la forme reconnue.** Ce n'est
pas un choix de style, et quatre remplacements enchaînés ne feraient pas la même chose : le
texte rendu par un callback n'est jamais relu par le moteur, alors qu'une passe suivante
relirait ce que la précédente a écrit. Or les valeurs injectées sont tirées des alphabets
mêmes que les détecteurs lisent, l'identifiant de substitution ayant exactement la forme d'un
identifiant et le nom de substitution étant un corps de mention comme une partie locale
d'adresse valides. Enchaîner ne peut donc pas être idempotent, quel que soit l'ordre.

**Une référence qui ne résout vers rien est retirée dans les métadonnées, laissée intacte
dans le texte.** L'asymétrie est mesurée, pas esthétique : les corps portent 10 534 jetons de
vingt-six caractères, dont 11 désignent un compte et 6 566 sont des permaliens que le format
conserve délibérément. Transporter ici la règle des métadonnées en détruirait 10 523 pour en
traiter 11.

**Les mentions collectives sont laissées intactes.** Sans règle explicite elles tombent dans
la neutralisation, ce qui abîmerait 3 585 messages pour zéro identité.

**Les substituts ne portent ni chevron ni arobase.** `<redacted>` aurait été relu par le rendu
markdown du viewer : le chevron coupe le lien là où il est posé, et une adresse remplacée dans
une destination de lien produit un lien de contact cliquable. 2 861 adresses de l'archive
vivent dans un lien markdown.

**Rejouer la commande sur sa propre sortie est refusé.** Presque sans effet avant cette étape,
destructeur depuis : aucun pseudonyme de la première passe ne résout contre une table neuve,
donc toutes les mentions deviendraient orphelines et seraient neutralisées. Le contrôle
résiduel ne le verrait pas, puisqu'il est positif contre le nouvel ensemble, cohérent avec
lui-même.

## Trois niveaux, parce que le coût n'est pas le même

Les étapes ne coûtent pas la même chose. Pseudonymiser les comptes ne touche à rien de ce
qu'on lit ; remplacer les noms écrits en clair abîme du texte, puisque aucun ancrage ne
distingue un prénom d'un mot ordinaire. Un réglage unique obligerait à en faire trop pour qui
veut relire, et pas assez pour qui doit diffuser.

`comptes` s'arrête aux fiches, aux métadonnées et aux binaires. `formes` ajoute ce qui est
ancré : mentions, adresses, numéros, identifiants. `noms` ajoute les noms écrits en clair, et
c'est le seul qui vise une diffusion. Le défaut est `noms`, parce qu'une archive livrée sans
mention du niveau doit être la plus protégée.

Ce qui les distingue n'est pas un degré de zèle mais une **promesse différente**, et le
manifeste comme le rapport disent laquelle a été tenue.

Une seule chose ne dépend d'aucun niveau : la substitution des noms que les métadonnées d'un
message système désignent. Ce n'est pas une réécriture de confort mais ce qui empêche une ligne
d'apparier une identité réelle et son pseudonyme. La rendre optionnelle laisserait le niveau le
plus bas porter la table de correspondance en clair.

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
identité qui fuit ne se rattrape pas une fois l'archive diffusée. Mais cette phrase n'a de
valeur qu'accompagnée d'un chiffre, et le voici.

Le critère décisif n'est ni la longueur ni le nombre de porteurs, c'est la **fréquence dans le
corpus**, et elle ne se devine pas : elle demande une passe de lecture. Une forme qui paraît
plus de deux cents fois n'est presque jamais une personne citée deux cents fois. Neuf formes
font à elles seules la moitié des occurrences du vocabulaire, et ce sont toutes des mots
ordinaires que quelqu'un porte aussi comme nom.

Le seuil retenu est 200, et c'est le point d'inflexion mesuré :

| Seuil de fréquence | Comptes couverts | Restant nommables | Messages touchés |
| --- | --- | --- | --- |
| 50 | 1 035 | 1 151 | 1,2 % |
| **200** | **1 509** | **677** | **4,8 %** |
| 500 | 1 793 | 393 | 11,0 % |
| 1 000 | 1 928 | 258 | 17,8 % |
| aucun | 2 000 | 186 | 40,4 % |

Au delà de 200, le volume de texte touché double bien plus vite que le nombre de personnes
protégées n'augmente. Le seuil est réglable par `--seuil-noms`, parce que l'arbitrage
appartient à qui diffuse et non à l'outil.

**Une forme que plusieurs comptes portent ne reçoit jamais le pseudonyme de l'un d'eux.** Le
cadrage a écarté le générateur de noms réalistes parce qu'attribuer les propos de quelqu'un au
nom d'une personne réelle fabrique une identité fausse ; or un pseudonyme est le nom d'une
personne de l'archive comme une autre. Remplacer « Martin », porté par trois comptes, par le
pseudonyme du premier ferait exactement cela, sur 9 901 occurrences mesurées. Ces formes
reçoivent donc un substitut neutre : on perd le fil, on ne fabrique pas d'attribution.

**186 comptes resteront nommables quel que soit le réglage.** Leurs formes font moins de quatre
lettres ou sont partagées par trop de comptes. Ce chiffre figure au rapport, et il ne descendra
pas.

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

## Ce que le rapport ne dira jamais

Le rapport est produit, en deux documents qui ne s'adressent pas au même lecteur. La
**synthèse** circule ; le **relevé** ne circule pas et doit être détruit.

Le piège de conception était que le rapport redevienne la table de correspondance qu'on vient
de jeter. Il ne suffit pas de s'interdire d'écrire les paires : plusieurs formes anodines la
restituent, et la signature du producteur est ce qui les rend impossibles plutôt
qu'improbables. Il reçoit des ensembles, jamais l'association.

Ce que la synthèse s'interdit, et pourquoi :

- **Aucune ligne par compte**, quel que soit le chiffre porté. Les volumes se recomptent
  depuis l'archive diffusée : deux listes se trient et s'apparient rang par rang.
- **Aucun décompte clé par une chaîne d'origine**, même sans imprimer la chaîne. Après la
  réécriture du texte, un pseudonyme apparaîtra dans l'archive autant de fois que la forme
  qu'il remplace ; compter les occurrences et lire la valeur en face suffirait.
- **Aucune date par compte**, à aucune granularité. Une date d'arrivée et une date de départ
  figurent dans un annuaire interne, et le lecteur lit le pseudonyme en face.
- **Aucun identifiant d'emplacement**, ni de message ni de canal : ils sont recopiés à
  l'identique dans l'archive diffusée, donc ce serait une clé de jointure exacte.
- **Aucune classe d'effectif inférieur à cinq**, fondue dans une classe plus large. Un
  décompte à un n'est pas un décompte, c'est une désignation.
- **Aucun tri par volume, par date ou par ordre d'origine.** L'ordre est un canal à part
  entière : un tri par volume est la fuite du volume sous forme ordinale.

Et **jamais de verdict positif**. Le verdict a deux valeurs, `non_diffusable` avec sa cause,
ou `sans_avis`. La raison n'est pas la prudence mais l'asymétrie de la preuve : une identité
trouvée est une preuve, aucune identité trouvée n'en est pas une, puisque le corps des
messages et les noms de canaux restent hors du périmètre vérifiable. Le vrai coût d'un
verdict positif est d'ailleurs pratique : il termine la revue, et personne ne lit les limites
d'un document qui s'ouvre sur « diffusable ».

## Ce que cela garantit, et ce que cela ne garantit pas

**L'archive n'est pas diffusable à ce stade.** Le manifeste le dit par ce qu'il n'énumère
pas : `anonymized.text_rewritten` liste les formes traitées, et `noms` n'y figure pas.

Est garanti dès maintenant, et uniquement sur les champs **structurés** : plus aucun
identifiant ni nom de compte parmi les auteurs de messages, les réactions, les déposants de
pièces jointes, les créateurs d'emoji, les fiches de comptes et les clés de référence de
`props` ; plus aucune adresse électronique de compte, plus aucun avatar, aucune pièce
jointe, aucune image d'emoji, plus d'URL d'instance, plus d'identité d'opérateur ; et la
correspondance vers les identités d'origine n'existe nulle part **pour qui ne détient pas
l'archive source**.

Cette dernière réserve est nécessaire et ne doit pas être retirée. Les identifiants de
messages, de canaux et de pièces jointes sont conservés délibérément, parce que la
vérification les exige et que les permaliens en dépendent : qui possède l'archive d'origine
peut donc apparier ligne à ligne, quel que soit le soin apporté au reste. La forme absolue
serait plus belle et un juriste la prendrait au mot.

Le **texte** conservé dans `props`, celui des blocs `attachments`, n'entre pas dans cette
garantie. `props` reste une structure ouverte, et ce texte est traité exactement comme le
corps des messages, c'est-à-dire pas encore : mesuré sur l'archive de référence, il porte
13 054 valeurs de `fields` et 1 896 champs de texte contenant un nom de compte.

N'est pas garanti, et le contrôle l'énumère à chaque exécution plutôt que de le taire : le
corps des messages, qui porte encore mentions, noms écrits en clair et adresses ; le texte
des blocs `attachments`, conservé pour ne pas vider 312 183 messages ; le nom et l'objet des
canaux ; le nom des emojis personnalisés, souvent formé sur un prénom ; le nom et la
description de la team, qui désignent l'organisation.

Trois résidus méritent d'être nommés parce qu'ils ont été mesurés sur l'archive produite.
Un prénom porté par plusieurs comptes reste en clair dans les messages système, et c'est
voulu : « vanessa » désigne quatre comptes de l'archive de référence, donc le substituer
serait arbitraire, et il n'apparie rien puisqu'il ne désigne personne en particulier.
Onze identifiants de comptes réels sont **collés dans le corps de sept messages**, sous
forme de permalien ou d'identifiant brut : la réécriture du texte devra donc traiter les
identifiants de 26 caractères, et pas seulement les mentions et les noms. Et une personne
désignée par un surnom, une initiale ou une orthographe approximative passera au travers,
ce qu'aucune règle automatique ne rattrapera.

C'est cette section, et non la commande, qu'il faut soumettre au juridique.

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
2. `mmarchive-anonymize` : pseudonymisation de tous les comptes, réduction de `props`,
   binaires non repris, manifeste réécrit, contrôle des identités résiduelles. **Livré.**
   Mesuré sur l'archive de référence : 3 277 comptes, 1 892 791 messages, 2 373 746
   références réécrites et 2 494 retirées faute de compte correspondant, en 35 secondes.
3. Le rapport, en deux documents. **Livré.** La synthèse circule et ne porte aucune chaîne
   d'origine ; le relevé porte le détail et se détruit. Le rapport s'écrit avant que le
   contrôle ne lève, sans quoi la seule exécution où il est indispensable serait précisément
   celle qui n'en produirait aucun.
4. La réécriture du texte sur les formes ancrées, dans les deux surfaces. **Livré.** Mesuré :
   245 313 mentions substituées et 15 591 neutralisées dans les corps, 73 191 adresses et
   1 235 numéros retirés, 11 identifiants de comptes substitués. Après la passe, plus aucune
   adresse ni aucun numéro, et zéro mention portant le nom d'un compte connu.
5. Le remplacement des noms en clair, sur les deux surfaces. **Livré**, derrière le niveau
   `noms`. Mesuré sur l'archive de référence avec le seuil par défaut : 1 715 formes retenues,
   590 écartées comme trop fréquentes, 1 504 comptes couverts et 683 laissés nommables. Les
   occurrences de noms de comptes passent de 1 358 817 à 795 860, celles qui restent portant
   sur les formes écartées.

## Ce qui reste à trancher

- **Les numéros de téléphone**, 2 903 messages : mêmes deux modes que les adresses, ou
  suppression pure.
- **La réversibilité par recoupement.** Même sans noms, un fil daté, situé dans un canal
  identifiable, avec un enchaînement de réponses caractéristique, peut désigner quelqu'un
  pour qui connaît le contexte. Aucune pseudonymisation n'y répond, et il faut le dire
  plutôt que de laisser croire le contraire.
