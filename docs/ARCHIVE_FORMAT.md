# Format d'archive mmarchive

**Version du schéma : 1**

Ce document spécifie le format produit par `mmarchive-extract`. Il est volontairement
indépendant de tout outil de consultation : l'archive est la donnée durable, le viewer
est remplaçable.

Toute implémentation capable de lire du JSON et du NDJSON peut exploiter une archive
mmarchive sans aucune dépendance à Mattermost.

---

## 1. Principes

1. **Formats ouverts et lisibles.** JSON pour les documents uniques, NDJSON (un objet
   JSON complet par ligne, séparateur `\n`) pour les collections. Encodage UTF-8 sans
   BOM. Aucun format binaire propriétaire.
2. **Streamable.** Aucun fichier ne nécessite d'être chargé intégralement en mémoire.
   Un canal de 200 000 messages se lit ligne à ligne.
3. **Canaux publics uniquement.** Le champ `type` d'un canal vaut toujours `"O"`.
   Une archive contenant un canal de type `P`, `D` ou `G` est invalide.
4. **Auditable.** Le manifeste permet de savoir ce que l'archive contient, ce qu'elle
   ne contient pas, et quels effets de bord l'extraction a produits sur l'instance
   d'origine.
5. **Versionné.** `manifest.schema_version` est incrémenté à chaque changement qui
   casserait un lecteur existant.

---

## 2. Arborescence

```
archive/
  manifest.json                    document unique, à lire en premier
  teams.ndjson                     une team par ligne
  channels.ndjson                  un canal par ligne
  users.ndjson                     un utilisateur par ligne
  emojis.ndjson                    un emoji custom par ligne
  files.ndjson                     une pièce jointe par ligne (métadonnées)
  posts/
    <channel_id>.ndjson            un message par ligne, trié par create_at croissant
  attachments/
    <file_id>/<nom_original>       contenu binaire des pièces jointes
  avatars/
    <user_id>.png                  image de profil
  emoji/
    <emoji_id>.png                 image d'emoji custom
  .extract-state.json              état de reprise, non normatif
```

Les chemins référencés depuis les enregistrements (`avatar`, `image`, `path`) sont
**relatifs à la racine de l'archive** et utilisent `/` comme séparateur, y compris
sur Windows.

### Pourquoi `attachments/<file_id>/<nom_original>`

Le nom d'origine est conservé pour le téléchargement, mais deux fichiers différents
peuvent porter le même nom. Le répertoire intermédiaire par `file_id` garantit
l'unicité sans renommer quoi que ce soit. Les noms sont assainis (voir §9).

---

## 3. Conventions communes

| Convention            | Règle                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| Timestamps Mattermost | Entier, millisecondes depuis epoch UTC. `0` signifie "jamais".         |
| Timestamps mmarchive  | Chaîne ISO 8601 UTC (`2026-08-24T10:00:00.000Z`).                      |
| Identifiants          | Chaîne de 26 caractères, alphabet `[a-z0-9]`.                          |
| Absence de valeur     | `null` pour un chemin non produit, chaîne vide pour un texte absent.   |
| Champ optionnel       | Absent de l'objet plutôt que présent à `null`, sauf mention contraire. |
| Suppression logique   | `delete_at != 0`. L'enregistrement est conservé.                       |

**Distinction importante sur `type`.** Pour un canal, `"O"` signifie _public_. Pour une
team, `"O"` signifie _ouverte à l'inscription_. Les deux champs sont homonymes et sans
rapport.

---

## 4. `manifest.json`

Document unique décrivant l'archive. C'est le point d'entrée de tout lecteur.

```json
{
  "schema_version": 1,
  "tool_version": "0.1.0",
  "source": {
    "url": "https://mattermost.example.org",
    "server_version": "9.5.2"
  },
  "extracted_at": "2026-08-24T10:00:00.000Z",
  "extracted_by": {
    "user_id": "…",
    "username": "lilian",
    "was_system_admin": false
  },
  "selection": {
    "mode": "file",
    "channels_total_public": 143,
    "channels_selected": 34,
    "channels_already_member": 30,
    "channels_joined_by_tool": 4,
    "channels_archived": 12
  },
  "options": {
    "include_emails": false,
    "skip_files": false,
    "leave_after": false,
    "max_file_size_mb": 100,
    "concurrency": 4,
    "rate_limit": 8
  },
  "joined_channels": [
    {
      "id": "…",
      "name": "tech-archi",
      "team_id": "…",
      "joined_at": "2026-08-24T10:02:11.000Z",
      "left": false
    }
  ],
  "joined_teams": [],
  "counts": {
    "teams": 2,
    "channels": 34,
    "posts": 512874,
    "users": 287,
    "emojis": 61,
    "attachments": 4021,
    "attachments_bytes": 8123456789
  },
  "post_range": {
    "first_create_at": 1490000000000,
    "last_create_at": 1756000000000
  },
  "warnings": [
    {
      "code": "ARCHIVED_CHANNEL_FORBIDDEN",
      "channel_id": "…",
      "detail": "403 sur posts?per_page=1, ViewArchivedChannels probablement désactivé"
    }
  ]
}
```

### `options.since` : présent seulement après une extraction incrémentale

Champ optionnel, absent d'une extraction complète. Il porte la date ISO passée à
`--since`, c'est-à-dire la borne basse de la remontée chronologique : aucun message
antérieur ne figure dans l'archive, quel que soit le canal.

Un lecteur qui le trouve sait que l'archive est **volontairement partielle dans le
temps**, ce que `post_range.first_create_at` ne dit pas à lui seul, puisque celui-ci
rend seulement le plus ancien message effectivement extrait.

Cette borne est appliquée côté client. Le paramètre `since` de l'API Mattermost n'est
pas utilisé : il sélectionne les messages *modifiés*, est plafonné à 1 000 et interdit
la pagination.

### `selection` : la complétude est auditable

`channels_total_public` est le nombre de canaux publics **visibles sur l'instance** au
moment de l'inventaire, sélectionnés ou non. L'écart avec `channels_selected` est
exactement ce que l'archive ne contient pas. Sans ce chiffre, un lecteur futur n'a
aucun moyen de savoir si l'archive est complète ou partielle.

### `joined_channels` : traçabilité des effets de bord

Rejoindre un canal publie un message système `system_join_channel` visible par tous
ses membres. Cette liste recense nominativement tout ce que l'outil a modifié sur
l'instance, pour qu'un tiers puisse en rendre compte.

### `warnings` : codes normatifs

| Code                          | Signification                                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| `ARCHIVED_CHANNEL_FORBIDDEN`  | Canal archivé dont la lecture a été refusée.                       |
| `CHANNEL_FORBIDDEN`           | Canal public sélectionné mais illisible.                           |
| `TEAM_NOT_MEMBER`             | Team dont le compte n'est pas membre : ses canaux sont invisibles. |
| `ORPHAN_THREAD_ROOT`          | Un message référence un `root_id` absent du canal.                 |
| `FILE_TOO_LARGE`              | Pièce jointe ignorée, au-dessus de `--max-file-size`.              |
| `FILE_DOWNLOAD_FAILED`        | Échec persistant du téléchargement d'une pièce jointe.             |
| `AVATAR_DOWNLOAD_FAILED`      | Échec du téléchargement d'un avatar.                               |
| `EMOJI_DOWNLOAD_FAILED`       | Échec du téléchargement d'une image d'emoji.                       |
| `USER_FETCH_FAILED`           | Un `user_id` référencé n'a pas pu être résolu.                     |
| `METADATA_FETCH_FAILED`       | Fiche illisible : `header`/`purpose`/`create_at` d'un canal, ou `description`/`type`/`create_at` d'une team. |
| `POST_METADATA_MISSING`       | Serveur ancien sans `post.metadata`.                               |
| `NON_PUBLIC_CHANNEL_REJECTED` | Le filtre défensif a rejeté une entrée non publique.               |
| `CHANNEL_INCOMPLETE`          | L'extraction d'un canal s'est arrêtée avant la fin.                |
| `LEAVE_FAILED`                | Échec au moment de quitter un canal rejoint.                       |

Un lecteur qui rencontre un code inconnu doit l'ignorer, pas échouer.

### `anonymized` : présent seulement après anonymisation

Champ optionnel, absent d'une archive d'extraction. Il est posé par
`mmarchive-anonymize` et dit jusqu'où l'anonymisation est allée :

```json
{
  "at": "2026-08-31T12:00:00.000Z",
  "tool_version": "1.1.0",
  "binaries_removed": true,
  "niveau": "noms",
  "text_rewritten": {
    "message": ["mentions", "adresses", "telephones", "identifiants", "noms"],
    "props.attachments": ["mentions", "adresses", "telephones", "identifiants", "noms"]
  }
}
```

`binaries_removed` dit une fois, ici, que les pièces jointes, avatars et emojis
personnalisés ne sont pas repris. Le répéter sur chaque ligne de `files.ndjson` par une
valeur de `skip_reason` aurait exigé d'étendre un enum fermé, donc de faire échouer la
lecture chez tout lecteur existant.

`niveau` nomme jusqu'où l'anonymisation est allée : `comptes`, `formes` ou `noms`. Ils ne
portent pas la même promesse, et un lecteur doit ignorer une valeur qu'il ne connaît pas.

`text_rewritten` énumère, par surface de texte, les **formes qui ont été traitées**. Jamais
ce qui reste. Les valeurs possibles sont `mentions`, `adresses`, `telephones`,
`identifiants` et `noms` ; un lecteur doit ignorer une valeur qu'il ne connaît pas.

L'absence de `noms`, comme dans une archive produite au niveau `formes`, dit que le corps des
messages porte encore des noms écrits en clair, et donc que **l'archive n'est pas
diffusable**. Cette lecture par l'absence est délibérée : une
liste de ce qui reste, une fois vide, se lirait comme une autorisation, alors que
l'anonymisation ne peut pas en donner.

Un lecteur qui trouve ce champ doit aussi savoir que les identifiants de comptes y sont
**tirés au hasard** : ils ont la forme d'un identifiant Mattermost mais ne désignent
plus rien sur l'instance d'origine, et aucune correspondance n'existe nulle part.

---

## 5. `posts/<channel_id>.ndjson`

Un message par ligne, **trié par `create_at` croissant**. Cet ordre est normatif : il
permet un rendu chronologique et une indexation par lecture séquentielle unique.

```json
{
  "id": "…",
  "channel_id": "…",
  "user_id": "…",
  "create_at": 1718000000000,
  "update_at": 1718000000000,
  "edit_at": 0,
  "delete_at": 0,
  "root_id": "",
  "type": "",
  "message": "texte markdown",
  "is_pinned": false,
  "hashtags": "",
  "props": {},
  "file_ids": ["…"],
  "reactions": [{ "user_id": "…", "emoji_name": "+1", "create_at": 1718000000000 }]
}
```

| Champ       | Notes                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `root_id`   | Chaîne vide pour un message racine, sinon l'id de la racine du fil.                                |
| `type`      | Chaîne vide pour un message normal, `system_*` pour un message système.                            |
| `edit_at`   | Non nul si le message a été édité. **L'historique d'édition est perdu.**                           |
| `message`   | Markdown Mattermost brut, non transformé.                                                          |
| `props`     | Objet libre côté Mattermost (attachments d'intégrations, overrides de webhook). Conservé tel quel. |
| `file_ids`  | Références vers `files.ndjson`. Peut être vide.                                                    |
| `reactions` | Aplati depuis `post.metadata.reactions`. Tableau vide si aucune réaction.                          |

Les messages système sont **conservés** avec leur `type`. Le filtrage à l'affichage est
une décision du viewer, pas de l'extracteur : on garde la donnée.

Un fichier de canal peut être absent si le canal a été sélectionné mais s'est révélé
illisible. Un warning correspondant figure alors dans le manifeste.

---

## 6. `channels.ndjson`

```json
{
  "id": "…",
  "team_id": "…",
  "name": "town-square",
  "display_name": "Town Square",
  "type": "O",
  "header": "…",
  "purpose": "…",
  "create_at": 1490000000000,
  "delete_at": 0,
  "total_msg_count": 12043,
  "last_post_at": 1756000000000,
  "was_joined_by_tool": false,
  "archived_post_count": 12043
}
```

`total_msg_count` est le compteur rapporté par Mattermost. `archived_post_count` est le
nombre de lignes réellement écrites dans `posts/<id>.ndjson`. Un écart entre les deux
signale une extraction partielle ou un décompte serveur approximatif, et se recoupe
avec les warnings.

`delete_at != 0` signifie que le canal est archivé côté Mattermost.

`header`, `purpose` et `create_at` sont relus sur la fiche du canal **avant l'extraction de
ses messages**, et non repris du fichier de sélection : celui-ci ne transporte que ce qui
sert à choisir, et il est éditable à la main. Un `METADATA_FETCH_FAILED` signale que la fiche
n'a pas pu être lue ; ces trois champs valent alors la chaîne vide et zéro, le reste de
l'enregistrement restant complet.

Cette relecture est aussi le dernier filtre défensif sur le type : c'est la seule
vérification qu'un fichier de sélection modifié à la main ne peut pas tromper, puisqu'elle
interroge l'instance. Un canal qu'elle révèle non public est écarté avant que le moindre de
ses messages ne soit lu, avec un `NON_PUBLIC_CHANNEL_REJECTED`.

---

## 7. `users.ndjson`

```json
{
  "id": "…",
  "username": "alice",
  "nickname": "",
  "first_name": "Alice",
  "last_name": "Martin",
  "position": "Développeuse",
  "roles": "system_user",
  "is_bot": false,
  "create_at": 1490000000000,
  "delete_at": 0,
  "avatar": "avatars/….png"
}
```

- `delete_at != 0` signifie **compte désactivé**. Ces utilisateurs sont conservés :
  leurs messages restent référencés dans l'archive.
- `avatar` vaut `null` si l'image n'a pas pu être récupérée.
- `email` n'est présent **que** si l'extraction a été lancée avec `--include-emails`.
  Aucun autre champ de contact (téléphone, `auth_data`) n'est jamais archivé.

> **`--include-emails` ne garantit pas une archive sans adresse e-mail.** Le flag ne
> contrôle que le champ `email` renvoyé par l'API. `nickname` et `position` sont des
> champs de profil libres, et les utilisateurs y écrivent fréquemment leur adresse
> (constaté sur des archives réelles : `position` valant
> `"📧 prenom.nom@exemple.org - CTO"`). Le corps même des messages peut en contenir.
> Une archive doit donc être traitée comme contenant des données personnelles, quelle
> que soit la valeur de ce flag.

---

## 8. `teams.ndjson`

```json
{
  "id": "…",
  "name": "equipe-produit",
  "display_name": "Équipe Produit",
  "description": "",
  "type": "O",
  "create_at": 1490000000000,
  "delete_at": 0,
  "was_joined_by_tool": false
}
```

---

## 9. `files.ndjson` et `attachments/`

Les métadonnées de pièces jointes sont stockées séparément du contenu binaire.

```json
{
  "id": "…",
  "post_id": "…",
  "channel_id": "…",
  "user_id": "…",
  "name": "compte-rendu.pdf",
  "extension": "pdf",
  "size": 184320,
  "mime_type": "application/pdf",
  "width": 0,
  "height": 0,
  "has_preview_image": false,
  "create_at": 1718000000000,
  "delete_at": 0,
  "path": "attachments/…/compte-rendu.pdf"
}
```

**`path` vaut `null` quand le binaire est absent de l'archive.** Le champ
`skip_reason` précise alors pourquoi :

| `skip_reason`       | Cause                                  |
| ------------------- | -------------------------------------- |
| `skipped_by_option` | Extraction lancée avec `--skip-files`. |
| `too_large`         | Taille au-dessus de `--max-file-size`. |
| `forbidden`         | Téléchargement refusé par le serveur.  |
| `download_failed`   | Échec réseau persistant après retries. |

Conserver la métadonnée sans le contenu permet au viewer d'afficher « pièce jointe non
archivée (trop volumineuse) » plutôt que de faire disparaître silencieusement une
information qui existait.

### Assainissement des noms de fichiers

L'archive contient des fichiers arbitraires téléversés par des tiers. Les noms écrits
sur disque sont assainis : séparateurs de chemin, caractères de contrôle, `..` et noms
réservés Windows sont neutralisés. Le nom d'origine reste intact dans le champ `name`
de `files.ndjson`. Un lecteur doit servir ces fichiers avec
`Content-Disposition: attachment` et `X-Content-Type-Options: nosniff`.

---

## 10. `emojis.ndjson` et `emoji/`

```json
{
  "id": "…",
  "name": "parrot",
  "creator_id": "…",
  "create_at": 1718000000000,
  "update_at": 1718000000000,
  "delete_at": 0,
  "image": "emoji/….png"
}
```

Les emojis custom sont nécessaires au rendu des réactions : une réaction référence un
`emoji_name`, pas une image. `image` vaut `null` si le téléchargement a échoué.

---

## 11. `.extract-state.json`

Fichier de travail de l'extracteur : curseur de pagination par canal, identifiants déjà
téléchargés, canaux et teams rejoints, warnings accumulés.

**Il n'est pas normatif** et n'est pas destiné aux lecteurs d'archive. Il est conservé
dans l'archive parce qu'il est la trace la plus fiable de ce qui a été rejoint, y
compris après un crash. Un lecteur doit l'ignorer.

Une archive passée par `mmarchive-anonymize` **ne le contient pas**. Son champ
`fetched_user_ids` est la liste exhaustive des comptes rencontrés, soit exactement ce
qu'une anonymisation vient de remplacer ailleurs ; le laisser annulerait tout le reste.
Son absence est aussi ce qui rend une archive anonymisée non reprenable contre
l'instance d'origine, ce qui est souhaitable.

---

## 12. Ce que le format ne peut pas contenir

L'API Mattermost ne restitue que l'état visible. Les éléments suivants sont
**définitivement perdus** et aucune version du format ne pourra les rattraper :

- **Messages supprimés.** Aucune trace.
- **Historique d'édition.** Seul `edit_at != 0` signale qu'un message a été édité ;
  les versions antérieures sont inaccessibles.
- **Historique des membres.** Qui était dans le canal et quand, hors messages système
  `system_join_channel` / `system_leave_channel` encore présents.
- **Accusés de lecture et statuts de présence.** Hors périmètre.
- **Canaux non sélectionnés.** Voir `manifest.selection.channels_total_public`.

Pour une assurance froide réellement complète avant décommission, la seule voie est un
`pg_dump` de la base plus un miroir du bucket de stockage objet. C'est hors du
périmètre de cet outil, mais c'est irrattrapable après coup.

---

## 13. Compatibilité et évolution

- Un lecteur **doit** vérifier `manifest.schema_version` et refuser une version majeure
  supérieure à celle qu'il connaît.
- Un lecteur **doit** ignorer les champs inconnus plutôt qu'échouer.
- L'ajout d'un champ optionnel n'incrémente pas `schema_version`.
- Le retrait d'un champ, le changement de type d'un champ, ou le changement de l'ordre
  normatif de `posts/*.ndjson` incrémentent `schema_version`.

## 14. Validation

Le paquet `@mmarchive/shared` expose des schémas zod pour chaque enregistrement
(`manifestSchema`, `archivePostSchema`, `archiveUserSchema`, `archiveChannelSchema`,
`archiveTeamSchema`, `archiveEmojiSchema`, `archiveFileSchema`). Ils constituent la
référence exécutable de ce document : en cas de divergence, c'est un bug, à corriger
des deux côtés.
