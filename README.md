# mmarchive

Archive les canaux **publics** d'une instance Mattermost vers un format ouvert et
durable, puis permet de les consulter hors ligne.

Conçu pour les instances en fin de vie : quand le serveur s'éteint, l'historique reste
lisible sans Mattermost, sans base de données à maintenir, et sans dépendre de l'outil
qui l'a produit.

> **État du projet.** L'extracteur et le viewer sont livrés. Le format d'archive est
> spécifié et versionné : voir [`docs/ARCHIVE_FORMAT.md`](docs/ARCHIVE_FORMAT.md).

---

## Ce que fait mmarchive

- Extrait l'intégralité des messages des canaux publics que vous désignez, avec leurs
  fils de discussion, réactions, pièces jointes, avatars et emojis personnalisés.
- Produit une arborescence de fichiers NDJSON documentée, lisible par n'importe quel
  outil.
- Ne touche à rien sans votre accord explicite, canal par canal.

## Ce que mmarchive ne peut pas faire

L'API Mattermost ne restitue que l'état visible. Sont **définitivement perdus** :

- les messages supprimés ;
- l'historique d'édition (seul un indicateur « modifié » subsiste) ;
- l'historique des membres, hors messages système encore présents.

Pour une assurance froide réellement complète avant une décommission, la seule voie est
un `pg_dump` de la base plus un miroir du bucket de stockage objet. C'est hors du
périmètre de cet outil, mais c'est irrattrapable une fois le serveur éteint. Faites-le
d'abord.

mmarchive n'archive **que** les canaux publics. Les canaux privés, les messages directs
et les conversations de groupe sont exclus par construction, à chaque étage du code.

---

## Installation

Prérequis : Node.js >= 22.12 et pnpm 10.

```bash
git clone <url-du-depot> mmarchive
cd mmarchive
pnpm install
pnpm build
```

---

## Obtenir un token

mmarchive s'authentifie avec un token porteur, envoyé en `Authorization: Bearer <token>`.
Trois provenances possibles, toutes équivalentes pour l'outil :

**1. Token de session** (le plus rapide, expire)

Connectez-vous à Mattermost dans votre navigateur, ouvrez les outils de développement,
puis `Application` → `Cookies` → valeur du cookie `MMAUTHTOKEN`.

**2. Personal Access Token** (le plus propre, si activé par l'administrateur)

`Profil` → `Sécurité` → `Personal Access Tokens` → `Create Token`. Si l'entrée n'apparaît
pas, un administrateur doit activer l'option dans la console système.

**3. Compte de bot** (pour un usage scripté)

`Console système` → `Intégrations` → `Bot Accounts`. Le bot doit être membre des équipes
concernées.

Placez le token dans un fichier `.env` à la racine :

```bash
cp .env.example .env
```

```
MM_URL=https://mattermost.example.org
MM_TOKEN=votre-token
```

> Un compte **administrateur système** est détecté automatiquement et peut lire tous les
> canaux publics sans rien rejoindre. C'est le mode sans aucun effet de bord. Si vous
> avez cette possibilité, utilisez-la.

---

## Le point important : rejoindre un canal laisse une trace

`GET /channels/{id}/posts` exige la permission `read_channel`. Un compte qui ne l'a pas
doit rejoindre le canal, et **rejoindre un canal publie un message système visible par tous
ses membres**. Sur plusieurs dizaines de canaux, cela produit une vague de notifications
très visible.

Selon la configuration de votre instance, cette permission peut vous être déjà accordée :
un Mattermost par défaut laisse le rôle `team_user` lire les canaux publics de ses teams
sans les rejoindre. Dans ce cas, aucun join n'est nécessaire et aucun message n'est publié.
mmarchive ne le suppose jamais : par défaut il sonde chaque canal non rejoint, en lecture
seule, et vous dit ce qu'il en est avant que vous ne choisissiez. `--no-probe` désactive ce
sondage, au prix d'un inventaire qui classera par prudence tout canal non rejoint comme
exigeant un join.

mmarchive ne rejoint **jamais** un canal de sa propre initiative. Vous les désignez un
par un, et l'outil vous montre le nombre exact de messages système que votre sélection
va publier avant de faire quoi que ce soit.

Quatre catégories, distinguées partout :

| Catégorie                 | Lisible                           | Rejoindre nécessaire | Effet de bord                 |
| ------------------------- | --------------------------------- | -------------------- | ----------------------------- |
| Public, déjà membre       | oui                               | non                  | aucun                         |
| Public, lisible sans join | oui, sondage concluant            | non                  | aucun                         |
| Public, non rejoint       | non                               | oui                  | message système dans le canal |
| Public, archivé           | selon la configuration du serveur | impossible           | aucun                         |

La deuxième ligne est de loin la plus fréquente sur l'instance qui a servi de référence.

---

## Utilisation

### 1. Inventaire

```bash
mmarchive-extract inventory --out channels.yaml
```

Options propres à l'inventaire :

```
  --out <file>         Fichier de sélection à produire (défaut : ./channels.yaml)
  --select-archived    Pré-coche aussi les canaux archivés lisibles
  --no-probe           Ne sonde pas les canaux non rejoints (plus rapide)
```

Aucune écriture sur l'instance, aucun canal rejoint, aucune donnée extraite. Produit un
fichier de sélection lisible et modifiable à la main :

```yaml
# Généré le 2026-08-24T10:00:00Z depuis https://mattermost.example.org
# Compte: alice (standard, non system_admin)
#
# selected: true  -> le canal sera extrait
# Les canaux joined: false ET selected: true déclencheront un join,
# qui publie un message système visible dans le canal.
# Total actuellement sélectionné: 34 canaux, ~180 000 messages, 0 join

teams:
  - id: xxxx
    name: equipe-produit
    display_name: Équipe Produit
    joined: true
    channels:
      - id: aaaa
        name: town-square
        display_name: Town Square
        joined: true # déjà membre
        archived: false
        message_count: 12043
        selected: true # défaut : true, aucun effet de bord

      - id: bbbb
        name: technique
        display_name: Technique
        joined: false # rejoindre nécessaire
        archived: false
        message_count: 8721
        selected: false # défaut : false, à cocher explicitement
```

Règle : un canal lisible sans effet de bord est coché par défaut, parce que c'est
gratuit. Un canal qui exigerait de le rejoindre ne l'est **jamais**. C'est vous qui cochez.

**Le sondage vaut la peine.** Par défaut, l'inventaire teste chaque canal non rejoint avec
une requête en lecture (`posts?per_page=1`) pour savoir s'il est lisible tel quel. Rien
dans l'API ne garantit qu'un compte donné puisse, ou ne puisse pas, lire un canal public
dont il n'est pas membre : cela dépend de la configuration des permissions du serveur.
Sonder donne la réponse vraie, sans aucun effet de bord, et peut supprimer la totalité des
joins qui semblaient nécessaires.

**Les canaux archivés restent décochés par défaut**, même lisibles : embarquer
l'historique d'un canal mort est une décision, pas un automatisme. Sur une instance
destinée à être décommissionnée, ils disparaîtront pourtant définitivement.
`--select-archived` les pré-coche.

### 1 bis. Calibrer (optionnel, mais utile avant un gros run)

```bash
mmarchive-extract doctor --file channels.yaml
```

Aucune écriture. Mesure trois choses que l'API ne documente pas et qui décident de la
durée d'une extraction :

- **le débit réellement autorisé**, lu dans les en-têtes `X-Ratelimit-*`. Mattermost ne
  les émet que si le limiteur est activé : leur absence signifie qu'aucune limite par
  utilisateur ne s'applique, et qu'un `--rate-limit` plus élevé est envisageable ;
- **la taille de page acceptée** pour les messages. La spécification ne documente aucun
  maximum ; si le serveur accepte 1000 au lieu de 200, le nombre de requêtes de pages est
  divisé par cinq (`--posts-page-size`) ;
- **une estimation du run** avant et après calibrage.

Le résultat décide de la stratégie. **Si le serveur applique une limite**, elle borne tout
et augmenter la parallélisation ne sert à rien : la concurrence sert alors à saturer le
débit autorisé, pas à le dépasser. **Si aucune limite ne s'applique**, le facteur limitant
devient la latence : à 90 ms, une seule requête en vol plafonne à 11 par seconde, et il
faut plusieurs requêtes simultanées pour utiliser le lien. `doctor` mesure la latence et
en déduit le couple `--rate-limit` / `--concurrency` à utiliser.

Dans tous les cas, montez par paliers : l'absence d'en-têtes ne prouve pas l'absence de
limite, un proxy en amont peut en appliquer une sans les émettre.

### 2. Sélection

À la main dans le fichier, ou en interactif :

```bash
mmarchive-extract select --file channels.yaml
```

Interface à cases à cocher, groupée par équipe, avec les canaux nécessitant un join dans
une section distincte. Le compteur de messages système induits est affiché en continu.

### 3. Extraction

```bash
mmarchive-extract run --file channels.yaml --out ./archive
```

Si la sélection implique de rejoindre des canaux, le CLI affiche la liste nominative, le
nombre de messages système que cela publiera, et demande une confirmation explicite.

À la fin du run, l'archive est **automatiquement vérifiée**. Une extraction assemblée en
plusieurs sessions peut être incohérente avec elle-même sans que rien ne le signale sur le
moment : mieux vaut le découvrir tout de suite que le jour où l'instance n'existe plus.
La commande sort avec un code d'erreur si un contrôle échoue. `--no-verify` saute cette
étape.

**Sans `--file`, le mode par défaut est le mode sûr** : uniquement les canaux déjà
accessibles, aucun canal rejoint, aucune requête d'écriture.

```bash
mmarchive-extract run --out ./archive
```

---

## Options

```
mmarchive-extract inventory [options]   (voir aussi --select-archived, --no-probe)
mmarchive-extract doctor [options]
mmarchive-extract verify --archive <dir>
mmarchive-extract select --file <yaml>
mmarchive-extract run [options]

  --url <url>              URL de l'instance (ou MM_URL)
  --token <token>          Token porteur (ou MM_TOKEN)
  --file <yaml>            Fichier de sélection (défaut : canaux déjà accessibles)
  --out <dir>              Répertoire de sortie (défaut : ./archive)

  --yes                    Pas de confirmation interactive des joins
  --join-teams             Autorise à rejoindre les équipes manquantes (défaut : false)
  --leave-after            Quitte les canaux rejoints en fin de run (défaut : false)

  --since <ISO8601>        Extraction incrémentale
  --resume                 Reprend depuis le fichier d'état
  --no-verify              Ne vérifie pas la cohérence de l'archive en fin de run

  --skip-files             N'extrait pas les pièces jointes
  --max-file-size <MB>     Ignore les fichiers au-dessus (défaut : 100)
  --include-emails         Inclut les adresses e-mail des utilisateurs (défaut : false)

  -v, --verbose            Sortie détaillée, sur la sortie d'erreur
  --no-input               N'essaie jamais de poser une question
  --no-color               Désactive la couleur (équivalent à NO_COLOR)
  --concurrency <n>        Canaux traités en parallèle (défaut : 4)
  --rate-limit <n>         Requêtes par seconde (défaut : 8)
  --posts-page-size <n>    Messages par requête (défaut : 200, voir `doctor`)
```

`--yes` court-circuite la confirmation, jamais la sélection : un canal non coché n'est
jamais rejoint, quels que soient les flags.

**`--leave-after` est à `false` par défaut.** Quitter un canal publie un second message
système : partir double le bruit. Sur une instance en fin de vie, cela n'apporte rien.
Le flag existe pour le cas où l'instance reste en service.

---

## Reprise après interruption

L'extraction écrit un fichier d'état (`.extract-state.json`) au fil de l'eau : curseur
de pagination par canal, pièces jointes déjà téléchargées, canaux rejoints.

```bash
mmarchive-extract run --file channels.yaml --out ./archive --resume
```

La reprise fonctionne y compris après une interruption au milieu d'un canal de 200 000
messages. Les canaux rejoints sont consignés dès le join, avant toute lecture, pour
rester traçables même après un arrêt brutal.

---

## Format d'archive

Spécification complète et normative : [`docs/ARCHIVE_FORMAT.md`](docs/ARCHIVE_FORMAT.md).

```
archive/
  manifest.json          ce que l'archive contient, et ce qu'elle ne contient pas
  teams.ndjson
  channels.ndjson
  users.ndjson
  emojis.ndjson
  files.ndjson
  posts/<channel_id>.ndjson
  attachments/<file_id>/<nom_original>
  avatars/<user_id>.png
  emoji/<emoji_id>.png
```

Le manifeste recense le nombre total de canaux publics de l'instance, pas seulement ceux
que vous avez sélectionnés : la complétude de l'archive reste auditable par un tiers.

---

## Vérifier une archive

```bash
mmarchive-extract verify --archive ./archive
```

Lecture seule, aucune connexion réseau. Contrôle la conformité aux schémas, l'absence de
canal non public, le tri chronologique des messages, l'absence de doublons, l'intégrité
référentielle entre messages, utilisateurs et pièces jointes, la présence sur disque des
chemins déclarés, et la cohérence des compteurs du manifeste avec le contenu réel.

Sort avec un code d'erreur non nul si un contrôle échoue, ce qui permet de l'enchaîner dans
un script de sauvegarde. `--no-blobs` saute la vérification d'existence de chaque pièce
jointe, qui coûte un appel système par fichier.

`--json` produit un rapport structuré sur la sortie standard, la progression et les
diagnostics restant sur la sortie d'erreur :

```bash
mmarchive-extract verify --archive ./archive --json | jq '.conformant'
```

À lancer après toute extraction, et surtout après une reprise : c'est ce contrôle qui
révèle qu'une archive assemblée en plusieurs runs est incohérente avec elle-même.

## Consulter l'archive

Le viewer est en lecture seule de bout en bout : aucune route d'écriture, aucun composeur,
et il ne connaît que l'archive, jamais Mattermost.

Il travaille sur un **index**, dérivé de l'archive et reconstruit en entier à chaque fois.
Rien n'y vit uniquement : le perdre ne coûte que le temps de le refaire.

```bash
pnpm mm:index build --archive ./archive --out ./index.db
pnpm mm:serve --index ./index.db --archive ./archive
```

L'archive est alors lisible sur `http://127.0.0.1:4173` : navigation par canal, fils de
discussion, recherche plein texte, pièces jointes et permaliens.

Depuis cette interface, le bouton de copie autonome produit un zip qui contient l'archive
et un viewer en un seul fichier HTML. Il s'ouvre en double-clic, sans serveur ni
installation : c'est le mode de consultation qui survivra le plus longtemps.

Pour héberger le viewer plutôt que de le lancer à la main, un `Dockerfile` et un
`compose.yaml` sont fournis :

```bash
docker compose up -d
```

Lisez [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) avant de l'exposer : le viewer n'a
aucune authentification, et c'est au mandataire inverse placé devant de la fournir.

## Conformité

Pour honorer une demande d'effacement après extraction :

```bash
mmarchive-redact --archive ./archive --user <user_id> --mode remove
mmarchive-redact --archive ./archive --user <user_id> --mode pseudonymize
```

`remove` supprime les messages et l'entrée utilisateur. `pseudonymize` remplace l'identité
par un identifiant stable et conserve les messages. Une réindexation est nécessaire
ensuite.

Dans les deux modes, l'effacement porte sur les **données**, pas seulement sur l'index qui
les décrit : l'avatar est retiré du disque, et en mode `remove` les pièces jointes de la
personne le sont aussi. Les compteurs du manifeste sont recalculés, de sorte qu'une archive
expurgée passe toujours `verify` : il ne faut pas avoir à choisir entre honorer une demande
d'effacement et conserver une archive cohérente.

L'opération modifie l'archive **en place, sans retour possible**. Sauvegardez avant.

### Rendre une archive entière diffusable

`redact` répond à la demande d'une personne. Quand c'est l'archive entière qui doit être
diffusée, l'exigence n'est plus la même et la commande non plus :

```bash
mmarchive-anonymize --archive ./archive --out ./archive-anonyme
```

### Trois niveaux, parce que le coût n'est pas le même

`--niveau <comptes|formes|noms>`, par défaut `noms`. Chaque niveau contient le précédent, et
ils ne portent pas la même promesse :

| Niveau | Ce qu'il ajoute | Coût sur le texte |
| --- | --- | --- |
| `comptes` | Fiches, métadonnées, références. Binaires non repris. | Aucun |
| `formes` | Mentions, adresses, numéros, identifiants collés. | Nul en pratique : tout est ancré |
| `noms` | Les noms écrits en clair. | Réel : un prénom est parfois un mot ordinaire |

Le défaut est `noms` parce qu'une archive livrée sans mention du niveau doit être la plus
protégée. Les niveaux inférieurs sont des choix explicites, pour relire ou pour diffuser en
interne.

`--seuil-noms <n>` règle le dernier niveau : au delà de N occurrences dans le corpus, une
forme est traitée comme un mot ordinaire plutôt que comme un nom. Par défaut 200, qui est le
point d'inflexion mesuré. Le manifeste et le rapport nomment tous deux le niveau appliqué.

Une chose ne dépend d'aucun niveau : la substitution des noms que les métadonnées d'un message
système désignent. Sans elle, une seule ligne apparie une identité réelle et son pseudonyme,
ce qui n'a de sens à aucun niveau.

Tous les comptes sont pseudonymisés, sous une forme manifestement artificielle du type
`Anon-Obsidienne-Discrete`. Les identifiants de substitution sont **tirés au hasard** : ils
gardent la forme d'un identifiant Mattermost mais ne désignent plus rien, et aucune
correspondance n'est conservée nulle part. Les pièces jointes, les avatars et les images
d'emoji ne sont pas repris, les métadonnées `props` sont réduites à ce qui se justifie, et
le manifeste perd l'URL de l'instance comme l'identité de l'opérateur.

`--out` est obligatoire et l'archive source n'est jamais modifiée. La sortie est bien plus
petite que l'entrée puisque les binaires n'y sont pas repris.

Un échec en cours de route laisse une sortie partielle, **à supprimer vous-même** : la
commande ne l'efface pas, et `--force` refuse de la remplacer. `--force` ne réécrit qu'une
sortie portant déjà une archive anonymisée complète, jamais un répertoire quelconque.

La commande produit une **synthèse** à côté de la sortie, jamais dedans. C'est le document
à faire lire avant toute diffusion : il donne un verdict, le périmètre de ce qui est garanti,
et surtout ce qui ne l'est pas, en faits chiffrés. Il ne contient aucun nom, aucune forme
résiduelle et aucun emplacement, parce qu'il circule.

`--releve <fichier>` produit en plus le détail : les canaux à relire à la main, les formes de
mention non résolues, les identifiants collés dans le corps. **Celui-là ne se diffuse pas** et
doit être détruit une fois les corrections faites, puisqu'il désigne précisément ce que
l'anonymisation a cherché à cacher. Il est écrit d'office quand le contrôle trouve quelque
chose, l'archive n'étant alors de toute façon pas diffusable.

La commande se termine par un contrôle des identités résiduelles. Il ne peut pas être sauté,
il n'existe aucun drapeau pour l'éviter. S'il trouve une seule identité survivante, la
commande échoue et l'archive produite ne doit pas être diffusée. S'il passe, il énumère ce
qu'il **ne couvre pas**, et cette liste vaut d'être lue.

Au niveau `noms`, les prénoms et noms de comptes écrits en clair sont remplacés par le
pseudonyme. C'est la seule étape sans ancrage, donc la seule où le sur-remplacement est un
risque : une forme trop fréquente dans le corpus est un mot ordinaire, pas une personne citée
mille fois, et elle est écartée. Le rapport annonce combien de comptes restent nommables
malgré tout, chiffre qu'aucun réglage ne ramène à zéro.

Le texte est réécrit sur ses **formes ancrées**, dans les messages comme dans le texte des
blocs d'intégration : les mentions qui désignent un compte prennent son pseudonyme et le fil
reste lisible, celles qui ne désignent personne sont neutralisées, les adresses et les
numéros de téléphone sont retirés. Les identifiants de comptes collés dans un message sont
substitués ; ceux qui ne désignent aucun compte sont laissés tels quels, parce que ce sont
des permaliens et que les détruire coûterait bien plus que ça ne rapporterait.

> À l'issue de cette étape, l'archive n'est **pas encore diffusable** : le corps des messages
> porte toujours des noms écrits en clair, que rien n'ancre et qui demandent une autre
> méthode. Le manifeste le dit par l'absence de `noms` dans
> `anonymized.text_rewritten`. Lisez
> [`docs/DECISION-ANONYMISATION.md`](docs/DECISION-ANONYMISATION.md), et en particulier la
> section « ce que cela garantit, et ce que cela ne garantit pas », avant toute diffusion.

---

## Sécurité

- **`--include-emails` ne suffit pas à anonymiser une archive.** Le flag ne contrôle que
  le champ `email` de l'API. Les champs de profil libres (`nickname`, `position`) et le
  corps des messages contiennent fréquemment des adresses, des numéros de téléphone ou
  d'autres données personnelles. Traitez toute archive comme contenant des données
  personnelles. Pour honorer une demande d'effacement, voir `mmarchive-redact` ; pour
  préparer une diffusion, voir `mmarchive-anonymize`, en lisant ce qu'il ne garantit pas.
- **Le token donne un accès en écriture à toute l'instance.** Ne le committez jamais.
  Le `.gitignore` couvre `.env`, les archives, les fichiers de sélection et les index.
- Une archive contient des échanges internes. Même publics au sein d'une organisation,
  ils ne sont pas destinés à être exposés. Le viewer n'écoute que la boucle locale par
  défaut et n'a aucune authentification : au delà de la machine, il faut un mandataire
  inverse qui authentifie. Voir [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md).
- Les fichiers d'une archive sont des contenus arbitraires téléversés par des tiers.
  Servez-les avec `Content-Disposition: attachment` et `X-Content-Type-Options: nosniff`.

---

## Utilisation en script

Toutes les commandes se comportent correctement hors terminal :

- **aucune question n'est jamais posée** sans terminal interactif, ni en intégration
  continue. Une confirmation impossible échoue avec un message actionnable plutôt que de
  suspendre le processus indéfiniment ;
- la **progression et les diagnostics vont sur la sortie d'erreur**, la sortie standard ne
  porte que le résultat : les sorties `--json`, le rapport de `mmarchive-index`, l'URL
  annoncée par `mmarchive-serve` et les scripts de complétion. Tout ce qui s'adresse à un
  lecteur humain passe par la sortie d'erreur, y compris les tableaux récapitulatifs ;
- `--json` produit une **sortie structurée** sur `inventory`, `doctor` et `verify`, ainsi
  que sur `mmarchive-index build`. Rien d'autre n'atteint la sortie standard, donc
  `mmarchive-extract inventory --json | jq .categories` fonctionne tel quel ;
- les **codes de sortie** sont exploitables : `0` succès, `1` échec, `2` argument invalide,
  `130` interruption par l'utilisateur ;
- `NO_COLOR` et `--no-color` sont respectés, la couleur est désactivée automatiquement
  quand la sortie est redirigée.

### Complétion shell

`mmarchive-extract` et `mmarchive-index` émettent leur propre script de complétion, pour
`bash`, `zsh` ou `fish` :

```bash
mmarchive-extract completion zsh > ~/.zfunc/_mmarchive-extract
```

Le script est dérivé du programme lui-même, pas d'une liste tenue à part : une
sous-commande ou une option ajoutée est complétée sans intervention.

## Codes d'erreur

Chaque erreur qui remonte à l'utilisateur porte un code stable, affiché devant le message :

```text
Echec : [E3002] posts/abc.ndjson ligne 41 : JSON invalide.
  mmarchive 1.1.0
```

La version accompagne le message parce qu'une panne est souvent rapportée par capture
d'écran, des mois plus tard : le code seul ne dit pas contre quelle version le relire.
Les codes qui désignent une panne de l'outil et non une saisie fautive y ajoutent
l'adresse où la signaler.

La famille dit d'où vient le problème : `E10xx` ce que vous avez fourni, `E20xx`
l'instance et les garde-fous, `E30xx` l'archive, `E40xx` la reprise, `E50xx` l'index.
La liste complète, avec la conduite à tenir pour chaque code, est dans
[docs/CODES-ERREUR.md](docs/CODES-ERREUR.md).

## Versions et releases

Les versions suivent le [semantic versioning](https://semver.org). Chaque release publie un
tag `vX.Y.Z`, une entrée de `CHANGELOG.md` et l'image du viewer sur
`ghcr.io/lsagetlethias/mmarchive-viewer`, en `amd64` et `arm64`. L'image se tire sans
authentification ; si votre compte crée les packages en privé, ouvrez sa visibilité une
fois, voir [`docs/RELEASE.md`](docs/RELEASE.md).

Le **numéro de schéma du format d'archive est indépendant** de celui de l'outil : une
nouvelle version de mmarchive ne rend pas les archives existantes illisibles. Voir
[`docs/ARCHIVE_FORMAT.md`](docs/ARCHIVE_FORMAT.md).

Le process est décrit dans [`docs/RELEASE.md`](docs/RELEASE.md).

## Développement

```bash
pnpm typecheck     # tsgo --noEmit
pnpm lint          # Biome puis ESLint type-aware
pnpm test          # Vitest
pnpm verify        # pipeline complet
```

## Licence

MIT. Voir [LICENSE](LICENSE).
