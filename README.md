# mmarchive

Archive les canaux **publics** d'une instance Mattermost vers un format ouvert et
durable, puis permet de les consulter hors ligne.

Conçu pour les instances en fin de vie : quand le serveur s'éteint, l'historique reste
lisible sans Mattermost, sans base de données à maintenir, et sans dépendre de l'outil
qui l'a produit.

> **État du projet.** L'extracteur est en cours de livraison. Le viewer (index SQLite,
> API en lecture seule, interface React) vient ensuite. Le format d'archive est déjà
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

`GET /channels/{id}/posts` exige la permission `read_channel`, accordée aux seuls
membres du canal. Avec un compte standard, vous ne pouvez donc lire que les canaux que
vous avez déjà rejoints.

**Rejoindre un canal publie un message système visible par tous ses membres.** Sur
plusieurs dizaines de canaux, cela produit une vague de notifications très visible.

mmarchive ne rejoint **jamais** un canal de sa propre initiative. Vous les désignez un
par un, et l'outil vous montre le nombre exact de messages système que votre sélection
va publier avant de faire quoi que ce soit.

Trois catégories, distinguées partout :

| Catégorie           | Lisible                           | Rejoindre nécessaire | Effet de bord                 |
| ------------------- | --------------------------------- | -------------------- | ----------------------------- |
| Public, déjà membre | oui                               | non                  | aucun                         |
| Public, non rejoint | non                               | oui                  | message système dans le canal |
| Public, archivé     | selon la configuration du serveur | impossible           | aucun                         |

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

  --skip-files             N'extrait pas les pièces jointes
  --max-file-size <MB>     Ignore les fichiers au-dessus (défaut : 100)
  --include-emails         Inclut les adresses e-mail des utilisateurs (défaut : false)

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

## Conformité

Pour honorer une demande d'effacement après extraction :

```bash
mmarchive-redact --archive ./archive --user <user_id> --mode remove
mmarchive-redact --archive ./archive --user <user_id> --mode pseudonymize
```

`remove` supprime les messages et l'entrée utilisateur. `pseudonymize` remplace
l'identité par un identifiant stable et conserve les messages. Une réindexation est
nécessaire ensuite.

---

## Sécurité

- **`--include-emails` ne suffit pas à anonymiser une archive.** Le flag ne contrôle que
  le champ `email` de l'API. Les champs de profil libres (`nickname`, `position`) et le
  corps des messages contiennent fréquemment des adresses, des numéros de téléphone ou
  d'autres données personnelles. Traitez toute archive comme contenant des données
  personnelles. Pour honorer une demande d'effacement, voir `mmarchive-redact`.
- **Le token donne un accès en écriture à toute l'instance.** Ne le committez jamais.
  Le `.gitignore` couvre `.env`, les archives, les fichiers de sélection et les index.
- Une archive contient des échanges internes. Même publics au sein d'une organisation,
  ils ne sont pas destinés à être exposés. Le futur viewer sera non public par défaut.
- Les fichiers d'une archive sont des contenus arbitraires téléversés par des tiers.
  Servez-les avec `Content-Disposition: attachment` et `X-Content-Type-Options: nosniff`.

---

## Développement

```bash
pnpm typecheck     # tsgo --noEmit
pnpm lint          # ESLint
pnpm test          # Vitest
pnpm verify        # pipeline complet
```

## Licence

MIT. Voir [LICENSE](LICENSE).
