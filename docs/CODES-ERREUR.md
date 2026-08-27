# Codes d'erreur

Chaque erreur que mmarchive fait remonter à l'utilisateur porte un code stable, affiché
entre crochets devant le message :

```
Echec : [E3002] posts/abc.ndjson ligne 41 : JSON invalide.
```

Un message se reformule, se traduit, se précise. Un code ne bouge pas. C'est lui qu'il
faut citer dans un rapport de bug ou chercher dans cette page, surtout quand la seule
trace disponible est une capture d'écran prise des mois plus tard.

La famille indique d'où vient le problème, ce qui oriente déjà la réponse :

| Famille | Origine                                              | Qui peut corriger        |
| ------- | ---------------------------------------------------- | ------------------------ |
| `E10xx` | La ligne de commande ou un fichier que vous fournissez | Vous, tout de suite      |
| `E20xx` | L'instance Mattermost, le réseau, les garde-fous      | Vous ou un administrateur |
| `E30xx` | Le format d'archive, sa lecture, ses chemins          | Souvent une reprise      |
| `E40xx` | L'état de reprise                                     | Vous, en arbitrant       |
| `E50xx` | L'index de consultation                               | Une reconstruction       |

Le registre vit dans [`packages/shared/src/errors.ts`](../packages/shared/src/errors.ts).
Un test d'invariant refuse toute classe d'erreur qui n'y figure pas, tout code attribué
deux fois, et toute entrée devenue orpheline : cette page ne peut donc pas se désynchroniser
silencieusement du code.

## E10xx, ce que vous avez fourni

| Code    | Situation                                                                | Que faire                                                                 |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `E1001` | Une option est absente, contradictoire ou hors bornes                     | Relire le message, il nomme l'option fautive. `--help` liste les valeurs acceptées |
| `E1002` | Le fichier de sélection est illisible, mal formé, ou viole une invariante | Le régénérer avec `inventory`, ou corriger la ligne signalée              |
| `E1003` | Le fichier de sélection vient d'une autre instance que celle visée        | Vérifier `--url`. Un fichier de sélection est lié à l'instance qui l'a produit |

## E20xx, l'instance et les garde-fous

| Code    | Situation                                                             | Que faire                                                                       |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `E2001` | Erreur Mattermost sans cas plus précis                                 | Le message reprend la réponse de l'instance                                     |
| `E2002` | Réponse HTTP en échec non couverte par un code plus précis             | Le message porte le statut et la route appelée                                  |
| `E2003` | Token absent, expiré ou révoqué                                        | Régénérer un token personnel, voir la section « Obtenir un token » du README    |
| `E2004` | Le compte n'a pas le droit de lire cette ressource                     | Typiquement un canal non rejoint. La sélection décide des joins, jamais l'outil |
| `E2005` | La ressource n'existe plus                                             | Canal supprimé depuis l'inventaire. Régénérer l'inventaire                      |
| `E2006` | L'instance applique une limitation de débit                            | L'outil patiente et réessaie seul. Persistant, baisser `--concurrency`          |
| `E2007` | Réponse reçue mais non conforme à ce que la version d'API annonce      | Signaler le cas, en précisant la version de Mattermost                          |
| `E2008` | L'instance est injoignable, DNS, TLS ou coupure réseau                 | Vérifier l'accès à `--url` depuis la même machine                               |
| `E2009` | Une écriture a été tentée hors de la porte de consentement             | Anomalie interne. Aucune écriture n'a eu lieu, merci de la signaler             |
| `E2010` | Un join a été tenté sur un canal que vous n'avez pas désigné           | Anomalie interne. Aucun join n'a eu lieu, merci de la signaler                  |
| `E2011` | Un canal non public a atteint un étage qui n'accepte que du public     | Anomalie interne, ou un YAML modifié à la main. Rien n'est entré dans l'archive |

`E2009`, `E2010` et `E2011` protègent les invariantes du projet : aucune écriture hors
consentement, aucun join implicite, canaux publics uniquement. Elles interrompent le
travail avant l'effet de bord, jamais après.

## E30xx, l'archive

| Code    | Situation                                                          | Que faire                                                                   |
| ------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `E3001` | Un fichier de l'archive est absent ou illisible                     | Le message nomme le fichier et la cause système                             |
| `E3002` | Une ligne NDJSON n'est pas du JSON valide                           | Le message donne le fichier et le numéro de ligne. Souvent une écriture interrompue, voir `verify` |
| `E3003` | Écriture impossible, disque plein ou droits insuffisants            | Libérer de la place ou corriger les droits, puis relancer, la reprise repart du dernier état sûr |
| `E3004` | Un enregistrement ne peut pas être sérialisé                        | Anomalie interne, merci de la signaler avec le message                      |
| `E3005` | Un chemin d'archive est invalide                                    | Vérifier `--out`, le message nomme la contrainte violée                     |
| `E3006` | Un chemin sort du répertoire de l'archive                           | Le viewer refuse de servir ce fichier. Archive corrompue ou fabriquée       |
| `E3007` | Le fichier de relecture inversée est inutilisable                   | Supprimer le fichier temporaire signalé et relancer                         |

## E40xx, la reprise

| Code    | Situation                                                    | Que faire                                                                            |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `E4001` | Le fichier d'état est illisible ou hors schéma                | Reprendre est impossible sans risque. Repartir d'une extraction neuve dans un répertoire vide |
| `E4002` | L'état ne correspond pas à ce qui est demandé                 | L'archive vient d'une autre instance ou d'une autre sélection. Le message nomme l'écart |

Ces deux erreurs bloquent volontairement plutôt que de deviner. Une reprise fondée sur un
état douteux produit une archive incohérente avec elle-même, ce que `verify` ne détecterait
qu'après coup.

## E50xx, l'index de consultation

| Code    | Situation                                          | Que faire                                                       |
| ------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `E5001` | La construction de l'index a échoué                 | Le message nomme l'étape. L'index partiel est supprimé, rien à nettoyer |
| `E5002` | Le fichier fourni n'est pas un index exploitable    | Reconstruire avec `mmarchive-view index build`                  |

L'index est dérivé : il se reconstruit intégralement depuis l'archive, et le perdre ne
coûte que le temps de reconstruction. Aucune donnée ne vit uniquement dedans.
