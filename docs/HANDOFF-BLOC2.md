# Handoff — bloc 2, viewer

Document de reprise. À lire en entier avant de toucher au viewer, avec
[CLAUDE.md](../CLAUDE.md) pour les conventions, [todo.md](../todo.md) pour ce qui reste
ouvert et [ARCHIVE_FORMAT.md](ARCHIVE_FORMAT.md) pour le format, qui est normatif.

---

## 1. Où en est le projet

Le bloc 1 est **livré et validé sur une extraction réelle**. Le viewer part donc d'une
archive qui existe vraiment, pas d'une spécification.

| Mesure | Valeur |
|---|---|
| Messages | 1 892 791 |
| Canaux | 758 extraits, sur 1331 publics visibles |
| Utilisateurs | 3 277 |
| Emojis personnalisés | 762 |
| Pièces jointes | 46 706, soit 25 Go |
| Amplitude | novembre 2020 → août 2026 |
| Canaux rejoints par l'outil | **0** |

Détail qui change des décisions du bloc 2 :

- **581 367 messages système**, soit **31 %** du total. Le format les conserve, le viewer
  les filtre à l'affichage. Un index qui les exclut ne porte que ~1,3 M d'entrées.
- **Canaux très inégaux** : 181 406 messages pour le plus gros, médiane autour de 265. La
  pagination et tout découpage doivent tenir les deux extrêmes.
- 223 192 messages avec réactions, 83 209 édités, 2 899 racines de fil hors archive
  (normal : la racine peut être hors fenêtre ou dans un canal non sélectionné).

**Non encore extrait** : 573 canaux archivés, 891 065 messages. Lisibles, sans join. C'est
la seule partie irréversible dans le temps, voir `todo.md`.

---

## 2. Contraintes d'hébergement, décidées

**Deux modes de distribution.**

- **lite** : HTML et JS statiques, utilisables tels quels sur GitHub Pages ou en local par
  simple ouverture de fichier. Pas de RAG. Recherche limitée à ce qu'un navigateur peut
  faire. C'est le mode « je remets l'archive à un tiers ».
- **full** : capacités serveur, RAG optionnel, et **téléchargement du lite depuis
  l'interface**. Le full sait donc produire le lite.

**Déploiement** : un Dockerfile et un docker-compose distribuent le projet. La
configuration du RAG reste externe, par variables d'environnement. Peu importe où c'est
hébergé du moment que Docker se déploie.

**Charge** : une vingtaine de lecteurs simultanés au maximum. Ce n'est pas un problème de
scalabilité, c'en est un de volumétrie de données.

---

## 3. Ce qui est déjà tranché et ne se rediscute pas

Ces points viennent du cadrage initial et ont tenu à l'épreuve du bloc 1.

1. **Canaux publics uniquement.** Filtre défensif à chaque étage, via `isPublicChannel` de
   `@mmarchive/shared`.
2. **Lecture seule intégrale côté viewer.** Aucune route d'écriture, aucun composer.
3. **L'archive ne dépend d'aucun outil.** Le viewer est jetable, l'archive non. Toute
   évolution du format passe par `ARCHIVE_FORMAT.md` **et** les schémas zod ensemble.
4. **Zéro dépendance à Mattermost après extraction.**
5. **RAG strictement optionnel.** L'outil doit être pleinement utilisable sans.
6. **Aucun appel réseau externe depuis le frontend.** Polices, icônes et emojis embarqués :
   l'archive doit tourner sur un réseau fermé.
7. **Servir les fichiers avec `Content-Disposition: attachment` et
   `X-Content-Type-Options: nosniff`.** Ce sont des contenus arbitraires téléversés par des
   tiers.
8. **Accès non public par défaut.** Même publics dans l'organisation, ces échanges ne sont
   pas destinés à être exposés.

---

## 4. Décisions du bloc 1 que le viewer doit connaître

**`files.ndjson` existe** et n'était pas dans le cadrage initial. Sans lui, on perdrait
nom, `mime_type`, taille et dimensions : ni miniature, ni `Content-Type` correct. Une pièce
jointe dont `path` vaut `null` a gardé sa métadonnée et porte un `skip_reason` : le viewer
doit afficher « pièce jointe non archivée » plutôt que de la faire disparaître.

**Les messages système sont conservés** avec leur `type` (`system_*`). Le filtrage est une
décision d'affichage.

**`is_pinned` n'est pas fiable** depuis l'API : il ne figure pas dans le schéma `Post` de la
spécification. Il est complété à l'extraction via `GET /channels/{id}/pinned`.

**Les identifiants Mattermost font 26 caractères** `[a-z0-9]`, mais **la spec ne le
garantit pas**. Ne pas en faire une contrainte dure côté viewer.

**`mmarchive-extract verify`** existe et vaut d'être réutilisé : c'est lui qui a trouvé
la plupart des défauts du bloc 1. Le builder d'index devrait refuser une archive qui ne
passe pas `verify`, ou au minimum le signaler.

---

## 5. Pièges déjà payés, à ne pas repayer

**U+2028 et U+2029.** `JSON.stringify` ne les échappe pas, ils sont légaux dans une chaîne
JSON, et ils apparaissent réellement dans les messages. Le `readline` de Node les traite
comme des fins de ligne : il coupait des enregistrements valides en deux et faisait passer
une archive saine pour corrompue. **Découper strictement sur `U+000A`.** Vaut pour tout
lecteur, donc pour le builder d'index.

**L'état et les fichiers sont deux sources de vérité concurrentes.** Cinq bugs du bloc 1,
tous de la même famille : du code qui décrivait la session au lieu de décrire l'archive.
Trois fois, un correctif a créé le suivant. **Quand un doute surgit, la réponse est dans les
fichiers.** Le garde-fou qui a fini par tenir est `verify`, lancé automatiquement.

**Le temps passe dans la latence, pas dans le débit.** Sur l'instance observée, 80 ms par
requête. Les traitements par lots verrouillés (`await Promise.all(lot)` puis lot suivant)
ramenaient une concurrence de 5 à 1,35 effective, parce qu'une tranche coûte le temps de son
élément le plus lent. Utiliser une **fenêtre glissante**, comme
`packages/extractor/src/extract/concurrency.ts`.

**Un CLI qui pose une question sans terminal ne gêne pas, il bloque.** Voir
`packages/extractor/src/ui/environment.ts`. La progression va sur la sortie d'erreur, le
résultat sur la sortie standard, sinon toute sortie structurée est inutilisable.

---

## 6. Stack actuelle

Node 24, pnpm 11, TypeScript 6 strict (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), tsgo 7 pour le typecheck rapide. **Biome** pour le formatage
et le lint syntaxique, **ESLint réduit aux seules règles type-aware**, sans aucune règle de
style, pour éviter que deux outils se disputent un fichier.

Le paquet `typescript` reste en 6 : typescript-eslint ne supporte pas encore l'API TS 7
(issue upstream 10940). Les règles type-aware ont trouvé plusieurs bugs réels, elles valent
ce report.

Commits et titres de pull request en **conventional commits, en anglais**, validés par
commitlint. Le reste du dépôt (documentation, commentaires, sortie du CLI) est en français.

`pnpm verify` enchaîne typecheck, lint, format, tests et build. Il doit passer avant toute
livraison. 503 tests aujourd'hui.

En développement, le CLI se lance sans build : `pnpm mm:verify`, `pnpm mm:doctor`, etc.

---

## 7. Questions ouvertes pour le bloc 2

À trancher avant d'écrire du code, avec les chiffres de la section 1 en main.

- **Index** : SQLite avec FTS5 et `bm25()` était le choix initial. À confronter à la
  volumétrie réelle et surtout au **mode lite**, qui doit fonctionner sans serveur. Un même
  index peut-il servir les deux modes, ou en faut-il deux ?
- **Serveur** : Hono ou Fastify. Peu d'enjeu à 20 lecteurs, choisir sur d'autres critères.
- **Mode lite** : quelle recherche est réellement possible côté navigateur sur 1,3 M de
  messages utiles, et quelle taille de téléchargement est acceptable.
- **Parser de syntaxe de recherche** : reproduire la syntaxe Mattermost (`from:`, `in:`,
  `before:`, `after:`, `on:`, phrase exacte, exclusion, `#hashtag`). Le cadrage le désigne
  comme la partie la plus piégeuse, et c'est cohérent : échappement FTS5, modificateurs
  cumulables et répétables. **À tester unitairement en priorité.**
- **RAG** : chunking par thread, jamais par message. Un « +1 » isolé pollue le retrieval.
  Retrieval hybride BM25 plus vectoriel, fusion RRF. Configuration externe, OpenAI-compatible.
