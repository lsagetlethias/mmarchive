---
name: sync-docs
description: Resynchronise la documentation de mmarchive après un changement de code. À utiliser après avoir modifié le format d'archive, les flags du CLI, la structure du repo ou les dépendances, ou quand l'utilisateur demande de mettre à jour la doc.
---

# sync-docs

Quatre documents doivent rester d'accord entre eux et avec le code.

| Document                 | Contenu                            | Se désynchronise quand                                  |
| ------------------------ | ---------------------------------- | ------------------------------------------------------- |
| `docs/ARCHIVE_FORMAT.md` | Spec normative du format d'archive | Un champ change dans `packages/shared/src/archive/`     |
| `README.md`              | Mode d'emploi destiné à un tiers   | Un flag, une commande ou une étape du flux change       |
| `CLAUDE.md`              | Conventions et hard rules          | La structure du repo, la stack ou une contrainte change |
| `.env.example`           | Variables d'environnement          | Une variable est ajoutée ou renommée                    |

## Procédure

1. Détermine ce qui a changé (`git diff`, ou la description de l'utilisateur).
2. Pour chaque document du tableau, vérifie le critère de désynchronisation.
3. Mets à jour **le minimum nécessaire**. Ne réécris pas un document entier pour un
   champ ajouté.

## Règles spécifiques

**Format d'archive.** `docs/ARCHIVE_FORMAT.md` et les schémas zod de
`packages/shared/src/archive/` sont deux faces de la même spec. Une divergence entre les
deux est un bug, à corriger des deux côtés. Si le changement casse un lecteur existant,
incrémente `SCHEMA_VERSION` dans `packages/shared/src/constants.ts` et documente-le dans
la section 13 du format.

**README.** Il s'adresse à quelqu'un qui ne connaît rien au contexte d'origine. Aucune
URL d'instance réelle, aucun nom de team, aucun identifiant de canal. Les exemples
utilisent `https://mattermost.example.org`.

**Effets de bord.** Toute modification qui change ce que l'outil écrit sur l'instance
Mattermost doit être répercutée dans le README **et** dans `CLAUDE.md`, section Hard
rules. C'est la partie que quelqu'un doit pouvoir vérifier sans lire le code.

## Finir

Relis les documents modifiés en entier une fois. Vérifie qu'aucun exemple de commande
ne référence un flag qui n'existe plus, et qu'aucun tableau de champs n'a d'entrée
orpheline.
