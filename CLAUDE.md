# CLAUDE.md — mmarchive

## First things first

- Lis ce document en entier avant de coder.
- **Le fichier d'environnement est interdit d'accès.** Un hook PreToolUse
  (`.claude/hooks/block-secrets.sh`) bloque Read/Write/Edit et toute commande Bash qui
  le référence. `MM_TOKEN` donne un accès en **écriture** à toute l'instance Mattermost.
  Si tu as besoin d'une valeur, demande à l'utilisateur. `.env.example` reste accessible.
- Manière de parler : direct, franc, pas de pincettes. Affirme avec confiance quand t'as
  les éléments. Familier OK, toujours pro. Tu proposes des alternatives quand c'est
  pertinent.

## Projet

**mmarchive** archive les canaux **publics** d'une instance Mattermost en fin de vie
vers un format neutre et durable, puis permet de les consulter hors ligne.

L'outil est générique : n'importe qui doit pouvoir archiver son instance et héberger son
propre viewer. Aucune trace du contexte d'origine dans le code ou la doc publique.

Deux blocs :

1. **Extracteur** (`packages/extractor`) — CLI `mmarchive-extract`. Inventaire,
   sélection, extraction. C'est la partie irréversible dans le temps : l'instance
   disparaît, l'extraction n'est rejouable que tant qu'elle est vivante.
2. **Viewer** (`packages/viewer`) — index SQLite, API en lecture seule, frontend React.
   Jetable et remplaçable. Ne démarre qu'une fois l'extracteur livré.

## Le problème central : les permissions

`GET /channels/{id}/posts` exige `read_channel`, accordée aux seuls membres du canal.
Un compte standard ne peut donc lire que les canaux qu'il a déjà rejoints. Rejoindre un
canal **publie un message système `system_join_channel` visible par tous ses membres**.
Sur des dizaines de canaux, c'est du spam très visible juste avant une décommission.

D'où le modèle de sélection en trois temps : `inventory` (aucune écriture) → `select`
(l'utilisateur coche) → `run` (confirmation nominative des joins). Il n'existe **aucun**
mode où l'outil joint un canal que l'utilisateur n'a pas désigné explicitement.

Trois catégories à distinguer partout, dans le code comme dans l'UX :

| Catégorie          | Lisible                      | Join requis | Effet de bord          |
| ------------------ | ---------------------------- | ----------- | ---------------------- |
| Public déjà membre | oui                          | non         | aucun                  |
| Public non rejoint | non                          | oui         | message système public |
| Public archivé     | selon `ViewArchivedChannels` | impossible  | aucun                  |

La logique vit dans `packages/shared/src/selection.ts` (`categorizeChannel`,
`requiresJoin`, `defaultSelected`, `summarizeSelection`) et est testée unitairement.
Ne la duplique jamais ailleurs.

## Volumétrie cible

Plus de 500 000 messages. Toute décision d'architecture doit tenir à cette échelle :
pagination keyset (jamais `OFFSET`), écriture NDJSON en append au fil de l'eau, jamais
de tampon mémoire global, virtualisation obligatoire côté rendu.

## Stack

- Node.js >= 24 (`.nvmrc` verrouille la majeure)
- pnpm 11, workspaces. La politique `minimumReleaseAge` refuse les paquets publies
  depuis moins d'une heure : c'est voulu, on epingle plutot que de la desactiver.
- TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  tsgo (`@typescript/native-preview` 7) pour le typecheck rapide.
  Le paquet `typescript` reste en 6 : typescript-eslint ne supporte pas encore
  l'API TS 7 (issue 10940), et les regles type-aware ont trouve plusieurs bugs reels.
- **Biome** pour le formatage et le lint syntaxique. **ESLint reduit au strict
  type-aware** (`no-unnecessary-condition`, `no-base-to-string`, ...), sans aucune
  regle de style : deux outils qui se disputent un fichier produisent des
  allers-retours a chaque enregistrement.
- Vitest 4
- zod pour la validation aux frontières
- commander (CLI), yaml (fichier de sélection avec commentaires préservés),
  @clack/prompts (TUI), cli-progress, picocolors
- tsup/esbuild pour bundler le CLI

## Structure

```
mmarchive/
├── .claude/
│   ├── hooks/block-secrets.sh   # PreToolUse : bloque tout accès au .env
│   ├── settings.json            # branche le hook + deny rules
│   └── skills/                  # verif, add-tests, sync-docs
├── docs/
│   ├── ARCHIVE_FORMAT.md        # spec du format, normative, versionnée
│   ├── CODES-ERREUR.md          # registre des codes, conduite à tenir
│   └── DEPLOIEMENT.md           # héberger le viewer
├── packages/
│   ├── shared/                  # types, schémas zod, logique de sélection, garde-fous
│   ├── extractor/               # CLI mmarchive-extract + mmarchive-redact
│   └── viewer/                  # index, serveur lecture seule, frontend React
├── Dockerfile                   # image du viewer seul, jamais de l'extracteur
├── compose.yaml                 # service viewer + construction d'index à la demande
└── .env.example
```

## Conventions code

- TypeScript strict, pas de `any` ; `unknown` + narrowing à la place.
- Pas de default exports.
- Imports relatifs **avec extension `.js`** (verbatimModuleSyntax + moduleResolution
  bundler).
- Pas de commentaires sauf POURQUOI non évident. Les identifiants bien nommés
  expliquent le QUOI.
- Nommage : camelCase pour variables et fonctions, PascalCase pour types, kebab-case
  pour les fichiers.
- Les champs qui viennent de l'API Mattermost gardent leur nom snake_case d'origine
  (`create_at`, `root_id`). Ne pas les camelCaser : le format d'archive les expose tels
  quels et un renommage casserait la correspondance avec la doc Mattermost.
- Validation zod **aux frontières uniquement** (réponse HTTP, fichier YAML, archive
  relue). Pas de revalidation en interne.
- Erreurs : classes dédiées avec un message exploitable par un humain qui lit un
  terminal, pas une stack trace brute.

## Scripts pnpm

| Commande                   | Effet                                       |
| -------------------------- | ------------------------------------------- |
| `pnpm typecheck`           | `tsgo --noEmit` (rapide)                    |
| `pnpm typecheck:tsc`       | Fallback `tsc --noEmit` (stable)            |
| `pnpm lint`                | Biome (avec correction) puis ESLint type-aware |
| `pnpm lint:check`          | Les deux, sans rien modifier                |
| `pnpm fmt` / `fmt:check`   | Biome                                       |
| `pnpm mm:*`                | Lance le CLI sans build, via tsx            |
| `pnpm test` / `test:watch` | Vitest                                      |
| `pnpm build`               | Bundle les packages qui ont un script build |
| `pnpm verify`              | typecheck + lint + fmt:check + test + build |

`pnpm verify` doit passer avant de livrer quoi que ce soit (skill `/verif`).

En developpement, le CLI se lance sans build : `pnpm mm:verify --archive ./archive`,
`pnpm mm:doctor --file channels.yaml`, etc. Le fichier d'environnement est charge
nativement par Node, sans dependance.

**Verifier une archive apres toute extraction** : `pnpm mm:verify --archive ./archive`.
C'est ce controle qui a revele qu'une archive assemblee en plusieurs runs pouvait
etre incoherente avec elle-meme.

## Commits et pull requests

Conventional commits, **en anglais**, valides par commitlint. Le reste du depot
(documentation, commentaires, messages du CLI) reste en francais pour l'instant.

Portees autorisees : `shared`, `extractor`, `viewer`, `format`, `cli`, `ci`,
`deps`, `docs`. Le titre de la pull request suit la meme convention, puisque
c'est lui que reprend le commit de fusion.

## Hard rules

1. **Canaux publics uniquement.** `type === "O"`, filtre défensif à chaque étage.
   Utiliser `isPublicChannel` / `assertPublicChannel` de `@mmarchive/shared`, jamais une
   comparaison inline. Un canal `P`, `D` ou `G` ne doit pas pouvoir entrer dans une
   archive, même via un YAML édité à la main.
2. **Aucun join implicite.** Le client HTTP refuse par construction toute méthode non
   GET, sauf via la porte de consentement (`MutationGate`) qui n'accepte qu'une liste
   nominative de `channel_id` validée par l'utilisateur. Ne jamais contourner cette
   porte, ne jamais y ajouter d'appel « pratique ».
3. **Lecture seule intégrale côté viewer.** Aucune route d'écriture, aucun composer.
4. **Séparation données / viewer.** L'archive ne dépend d'aucun outil. Toute évolution
   du format passe par `docs/ARCHIVE_FORMAT.md` et par les schémas zod de `shared`, les
   deux ensemble.
5. **Zéro dépendance à Mattermost après extraction.** Le viewer ne connaît que
   l'archive.
6. **RAG strictement optionnel.** L'outil doit être pleinement fonctionnel sans.
7. **Jamais de tampon mémoire global.** À 500 000 messages, tout se fait en flux.

## Interdits

- Lire, écrire, copier, déplacer ou sourcer le fichier d'environnement.
- Ajouter une méthode d'écriture au client Mattermost hors de `MutationGate`.
- Committer une archive, un `channels.yaml` ou un `index.db` : ils contiennent des
  échanges internes et la topologie de l'instance (`.gitignore` les couvre).
- Hardcoder une URL d'instance, un nom de team ou un identifiant de canal dans le code
  ou la doc publique.
- Ajouter des emojis dans le code ou les commits.
- Le caractère tiret cadratin dans quoi que ce soit de produit.

## Notes de fidélité à ne pas oublier

L'API ne rend que l'état visible. Messages supprimés, historique d'édition et historique
de membres sont **perdus**. Seul `edit_at != 0` signale une édition. Les messages
système sont extraits avec leur `type` et filtrés à l'affichage, jamais à l'extraction :
on garde la donnée, le viewer décide.

## Référence d'inspiration

Bootstrap inspiré de `~/source/ADEME/n8n-automations` (CLAUDE.md, hook anti-secrets,
tooling TS strict), `~/source/fine-grained-proxy` et `~/source/roadmaps-faciles` (skills
locaux `verif` / `add-tests` / `sync-docs`), `~/source/ADEME/service-fait-maker`
(intégration Mattermost, `@clack/prompts`).
