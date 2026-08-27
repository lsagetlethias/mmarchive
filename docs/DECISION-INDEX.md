# Décision : l'index du viewer

Statut : validé le 25 août 2026. Mis en oeuvre par `packages/viewer`, dont le builder
d'index produit exactement le schéma décrit ici. Les invariants du §5 sont couverts par
`packages/viewer/tests/build-index.test.ts`.

Ce document tranche la question laissée ouverte au §7 du [handoff](HANDOFF-BLOC2.md) :
SQLite avec FTS5 tenait-il encore une fois la volumétrie réelle connue, et surtout
face au mode lite qui doit fonctionner sans serveur.

Tout ce qui est chiffré ici a été mesuré sur l'archive réelle (1 892 791 messages,
758 canaux, 27 Go), pas estimé. Le protocole est en fin de document pour être rejouable.

---

## 1. Ce que l'archive contient vraiment

| Mesure | Valeur |
| --- | --- |
| Messages totaux | 1 892 791 |
| Messages humains | 1 311 424 (69 %) |
| Messages de bots et système | 581 367 (31 %) |
| Texte des messages humains | 251 Mo |
| Longueur moyenne d'un message | 191 octets |
| Messages avec réactions | 221 438, pour 430 827 réactions |
| Racines de fil absentes | 17 871 |

**Correction au handoff.** Les 581 367 messages « système » ne sont pas du join/leave.
Ce sont 332 613 `slack_attachment` et 179 728 `custom_git_pr`, c'est à dire du contenu
de bots dont le texte vit dans `props` et non dans `message`. Les vrais messages système
(join, leave, ajout, changement d'en-tête) ne représentent qu'environ 66 000 entrées.

Conséquence directe : le canal le plus volumineux de l'archive (181 432 messages,
192 Mo de NDJSON) ne contient que **302 messages humains**. La volumétrie brute est
dominée par des notifications d'intégrations, pas par de la conversation. Dimensionner
l'index sur les 1,9 M de messages serait dimensionner sur du bruit.

Décision prise : les messages de bots sont traités comme du bruit, au même titre que les
join/leave. Ils restent dans l'archive, l'index ne les porte pas. L'index couvre donc
**1 311 424 messages**.

---

## 2. Les quatre approches, confrontées aux chiffres

### SQLite côté serveur

Sans surprise, tout passe. Requêtes entre 1 et 10 ms sur l'index complet. Aucun point dur.
C'est la référence à laquelle les autres options doivent se comparer.

### Index entièrement chargé dans le navigateur

Non viable, et l'écart n'est pas discutable. L'index fait 588 Mo, 252 Mo compressés. Il
faudrait le télécharger intégralement avant le premier affichage. Un index en mémoire de
type MiniSearch ou Orama sur 1,3 M de documents demanderait plusieurs gigaoctets de RAM :
hors de question sur un poste ordinaire, sans même parler d'un mobile.

### Index segmenté par canal

Mesuré en construisant réellement les 699 fragments : 78 Mo au total une fois compressés,
médiane à 16 Ko, 90e centile à 300 Ko, le plus gros fragment à 2,4 Mo. Aucun ne dépasse
5 Mo.

C'est excellent pour la navigation et ça évite tout mécanisme de lecture partielle. Mais
la recherche globale exige alors soit un index global séparé, soit le téléchargement de
tous les fragments. La segmentation résout donc la lecture, pas la recherche. Elle reste
une roue de secours si la lecture paresseuse s'avérait impraticable.

### SQLite lu paresseusement, par plages

C'est l'option retenue, parce qu'une mesure la rend possible et qu'elle satisfait seule la
contrainte du « full qui produit le lite ».

**Un index de 588 Mo se consulte en lisant quelques dizaines de kilooctets.** Cache froid,
pages de 4 Ko, chaque scénario mesuré dans un processus neuf. Les chiffres ci-dessous sont
relevés sur l'index que produit `mmarchive-index`, pas sur une maquette :

| Opération | Pages lues | Trafic |
| --- | --- | --- |
| Ouverture de la base | 1 | 4 Ko |
| Accueil, 50 canaux | 21 | 84 Ko |
| Ouvrir un canal, 50 derniers messages | 43 | 172 Ko |
| Défiler, 50 messages de plus | 25 | 100 Ko |
| Réactions d'une page de 50 messages | 22 | 88 Ko |
| Pièces jointes d'une page | 7 | 28 Ko |
| Permalien, résolution d'un id Mattermost | 8 | 32 Ko |
| Ouvrir un fil | 330 | 1,3 Mo |
| Recherche d'un mot (8 074 résultats), par date | 64 | 256 Ko |
| Phrase exacte, par date | 366 | 1,4 Mo |
| Restriction à un canal (`in:`) | 80 | 320 Ko |
| Restriction à un auteur le plus actif (`from:`) | 106 | 424 Ko |
| Exclusion d'un terme | 17 | 68 Ko |
| Préfixe, pour l'autocomplétion | 18 | 72 Ko |
| Annuaire, 200 utilisateurs | 101 | 404 Ko |

Soit 0,03 % de la base pour ouvrir un canal.

---

## 3. Le mode lite est réalisable, y compris en double-clic

Mesuré dans Chrome, sur le protocole `file://` :

| Capacité | Résultat |
| --- | --- |
| `fetch`, y compris avec `Range` | bloqué |
| `XMLHttpRequest` | bloqué |
| `Worker` depuis un fichier | bloqué |
| `OPFS` | bloqué |
| `SharedArrayBuffer`, `crossOriginIsolated` | absent, `false` |
| `WebAssembly` | disponible |
| `IndexedDB` | disponible |
| `Worker` créé depuis une URL blob | disponible |
| `File.slice` sur un fichier désigné | disponible |
| `FileReaderSync` dans un Worker | disponible |

Deux conséquences.

**Un viewer ouvert en double-clic ne peut rien charger de lui même.** Aucune requête
sortante n'est permise. Il faut que l'utilisateur désigne le fichier d'index, une fois,
via un sélecteur ou un glisser-déposer.

**Mais une fois le fichier désigné, tout redevient possible.** `File.slice(1000, 1100)`
lit une plage arbitraire d'un fichier de 733 Mo sans le charger : c'est exactement
l'équivalent local d'une requête `Range`. Et `FileReaderSync`, disponible dans un Worker
créé depuis une URL blob, rend cette lecture **synchrone**, ce qui est précisément ce
qu'exige SQLite. Mesure : 200 pages de 4 Ko à des offsets dispersés lues en 79 ms, soit
0,4 ms par page. Ouvrir un canal coûte donc environ 17 ms.

C'est le point qui débloque tout, parce que la parade habituelle au caractère synchrone de
SQLite (`SharedArrayBuffer` plus `Atomics.wait`) est indisponible en `file://`, où
`crossOriginIsolated` vaut `false`.

### Un index, trois transports

Le VFS s'écrit une fois, avec trois implémentations de la seule primitive « lis N octets à
l'offset O » :

1. Mode full : lecture disque directe via `node:sqlite`.
2. Mode lite servi en statique : requête HTTP `Range`, en XHR synchrone dans un Worker.
3. Mode lite en double-clic : `File.slice` plus `FileReaderSync` dans un Worker.

Le fichier d'index est **le même octet pour octet** dans les trois cas. « Télécharger le
lite depuis le full » revient donc à zipper l'index et les fichiers statiques du frontend,
sans second pipeline ni second format. C'est la contrainte forte du cadrage, satisfaite
par construction plutôt que par discipline.

### Ce que le mode lite a coûté, une fois réalisé

Mesuré sur l'index réel de 655 Mo, avatars et emojis compris :

| Opération, en mode lite servi en statique | Requêtes | Trafic | Durée |
| --- | --- | --- | --- |
| Ouvrir un canal | 25 | 1,6 Mo | 0,8 s |
| Ouvrir un canal plus dense | 79 | 5,1 Mo | 1,0 s |
| Rechercher un mot | 24 | 1,5 Mo | 1,0 s |

Le trafic dépasse celui du mode serveur (170 Ko pour un canal) parce que les lectures sont
regroupées en blocs de 64 Ko : c'est le prix à payer pour ne pas faire une requête par page
de 4 Ko. Le compromis se règle d'une constante, `BLOCK_SIZE`.

**L'ouverture en double-clic impose un artefact distinct.** Trois refus de Chrome, tous
mesurés, l'expliquent : un module ES chargé depuis `file://` est refusé par la politique
d'origine croisée, un Worker ne peut pas être chargé depuis un fichier voisin, et aucune
requête n'est possible, pas même vers le fichier d'à côté. La sortie autonome est donc un
script classique, dont le Worker est instancié depuis une URL blob et dont le moteur SQLite
est inclus en base64. Résultat : un `archive.html` de 1,8 Mo, dont 1,1 Mo de moteur, qui
ouvre un index de 655 Mo désigné à la main.

Avatars et emojis vivent dans l'index (table `asset`, 68 Mo pour 4 039 fichiers) pour cette
raison précise : sans eux, une archive ouverte depuis un disque s'afficherait sans visages.
Les pièces jointes, elles, restent en métadonnées : leurs 26 Go n'ont pas vocation à
voyager dans un index.

---

## 4. Schéma retenu

```sql
CREATE TABLE post (
  rowid INTEGER PRIMARY KEY,  -- ordre chronologique global, voir invariant 1
  pid TEXT,                   -- id Mattermost, pour les permaliens d'origine
  ch INTEGER, usr INTEGER,    -- références entières, pas les id de 26 caractères
  create_at INTEGER,
  root INTEGER,               -- rowid de la racine du fil, NULL si racine
  flags INTEGER               -- édité, épinglé, pièces jointes, réactions, supprimé
);
CREATE TABLE post_text (rowid INTEGER PRIMARY KEY, message TEXT);
CREATE VIRTUAL TABLE search USING fts5(
  message, tag, content='', detail='full',
  tokenize="unicode61 remove_diacritics 2"
);
```

Plus `channel`, `user`, `reaction` et `file`, et les index `post_ch(ch, rowid)`,
`post_usr(usr, rowid)`, `post_root(root)` partiel, `post_pid` unique.

Composition des 588 Mo réellement produits sur l'archive complète :

| Élément | Taille | Part |
| --- | --- | --- |
| `post_text` | 269 Mo | 46 % |
| `search`, l'index FTS5 | 137 Mo | 23 % |
| `post` | 65 Mo | 11 % |
| `post_pid`, l'index des permaliens | 44 Mo | 8 % |
| `post_ch` et `post_usr` | 37 Mo | 6 % |
| `reaction` et son index | 17 Mo | 3 % |
| `post_root` | 9 Mo | 2 % |
| `file`, métadonnées des pièces jointes | 8 Mo | 1 % |

Construction complète depuis l'archive : **61 secondes**, validation zod de chaque
enregistrement comprise. L'index est donc réellement jetable : le reconstruire coûte moins
cher que de le réparer, ce qui est cohérent avec la leçon du bloc 1 sur les deux sources
de vérité concurrentes.

### Trois choix qui expliquent ces chiffres

**Les identifiants sont normalisés en entiers.** Un id Mattermost coûte 27 octets. Les
remplacer par des références entières dans `post` économise environ 100 Mo. Le champ `pid`
n'est conservé que pour résoudre les permaliens d'origine, et il coûte 44 Mo d'index à lui
seul : le rendre optionnel est la première économie disponible si la taille devient un
problème.

**Le texte est séparé des métadonnées.** `post` sans le texte fait 66 Mo au lieu de 336 Mo
d'un seul tenant. Toutes les opérations qui filtrent, trient ou paginent ne touchent que la
petite table, ce qui divise par cinq le nombre de pages lues.

**Les filtres sont indexés comme des termes.** La colonne `tag` porte `c<canal>`,
`u<auteur>` et `h<hashtag>`. FTS5 intersecte alors deux listes au lieu de vérifier une
jointure ligne à ligne. Mesure : `in:` passe de 5 781 pages (23 Mo) à 80 pages (320 Ko),
soit 72 fois moins. Coût : 19 Mo.

Les hashtags sont réduits à leurs lettres et chiffres avant d'être indexés. Le tokenizer
coupe sur le tiret, si bien que `#note-de-cadrage` produirait trois termes dont
deux se confondraient avec des mots ordinaires du corpus. La requête subit la même
normalisation, ce qui garde les deux côtés alignés.

---

## 5. Invariants à respecter

Ce sont des propriétés dont dépendent les chiffres ci-dessus. Chacune doit être couverte
par un test, sans quoi elle se perdra silencieusement.

**1. `rowid` porte l'ordre chronologique global.** C'est ce qui rend le tri par date
gratuit : FTS5 parcourt sa liste à l'envers, sans jamais lire les dates. Mesure du même
tri sans cet invariant : 10 836 pages, soit 43 Mo, contre 66 pages. Le facteur est de 164.

**2. Trier par `rowid`, jamais par `create_at`.** Les deux ordres sont équivalents, mais
SQLite l'ignore. Écrire `ORDER BY create_at DESC` ramène le coût à 13 090 pages, c'est à
dire pire que de ne pas avoir l'invariant du tout. C'est le piège le plus facile à
introduire par mégarde, et le plus coûteux.

**3. Le tri par défaut est la date, pas la pertinence.** Classer par `bm25()` oblige à
scorer tous les résultats : 2 711 pages, soit 10,8 Mo, pour un mot fréquent. C'est
acceptable côté serveur, pas sur un index distant. Mattermost lui même affiche les
résultats récents d'abord. La pertinence reste offerte en option explicite.

**4. Découper les lignes NDJSON strictement sur `U+000A`.** Déjà payé au bloc 1, vaut pour
le builder d'index comme pour tout autre lecteur.

---

## 6. Ce qui reste ouvert

**La croissance à venir.** Les 573 canaux archivés non encore extraits ajouteront 891 065
messages, soit environ 45 %. L'index passerait à peu près à 850 Mo. Toutes les mesures de
trafic par écran restent inchangées, puisqu'elles ne dépendent pas de la taille du fichier,
mais l'hébergement statique devient tendu.

**GitHub Pages est possible mais serré.** Le plafond du site publié est de 1 Go, appliqué
au déploiement. Aucun fichier ne peut dépasser 100 MiB, ce qui impose de découper l'index
en au moins sept morceaux. Surtout, Pages compresse en gzip les fichiers servis en
`application/octet-stream` et les requêtes `Range` portent alors sur les octets compressés :
le serveur répond 206, le client croit que tout va bien, et lit des pages incohérentes. Le
bug est ouvert côté GitHub et sans correctif. Un hébergement statique ordinaire (nginx,
S3, Netlify) n'a aucun de ces trois problèmes, et c'est la cible à privilégier.

**Le coût d'ouverture d'un fil, à 331 pages.** L'index partiel sur `root` disperse les
réponses d'un même fil. Regrouper physiquement les fils, ou dénormaliser, ferait tomber ce
chiffre. À mesurer avant d'optimiser : 1,3 Mo reste acceptable.

**Le serveur du mode full : Fastify plutôt que Hono.** Décidé sur des mesures, pas sur des
préférences. `@hono/node-server` n'émet ni `ETag` ni `Cache-Control`, ne répond jamais 304
sur une revalidation conditionnelle, ignore `If-Range`, et sur une requête à plages
multiples renvoie un 206 annonçant tout le fichier, ce qui est non conforme.
`@fastify/static` gère correctement l'ensemble et expose la politique de cache en
configuration. Sur 26,4 Go de pièces jointes servies à des lecteurs qui rechargent,
l'absence de 304 est le premier poste de bande passante.

---

## 7. Protocole, pour rejouer les mesures

Toutes les mesures viennent de l'archive réelle, sur macOS, SQLite 3.51 et Node 25.

Les tailles par table sont lues dans la table virtuelle `dbstat`, pas déduites de la taille
du fichier. Le trafic est mesuré via le compteur `Page cache misses` de `sqlite3 .stats`,
chaque scénario tournant dans un processus neuf pour garantir un cache vide : ce compteur
donne le nombre de pages que le VFS doit réellement aller chercher, indépendamment du cache
du système de fichiers. Les capacités du navigateur sont testées dans Chrome piloté par le
protocole de debug, sur de vraies URL `file://`.

Deux pièges rencontrés pendant ces mesures, notés pour qui les rejouerait. `CREATE TABLE
AS SELECT rowid, ...` crée une colonne ordinaire nommée `rowid` et non la clé primaire :
chaque lecture devient alors un balayage complet, ce qui faisait apparaître des lectures à
6 ms au lieu de quelques microsecondes. Et un post-filtrage tronqué par une clause `LIMIT`
donne l'illusion d'un désaccord de résultats là où il n'y en a pas.
