# Audit du dépôt

Établi le 1er septembre 2026, sur `main` (`6dc37d6`).
Procédure : `.claude/skills/audit-repo/SKILL.md`. RAG hors périmètre.

**État : complet.** Les cinq volets sont passés. Les constats de la passe précédente,
établie sur `feat/rag-lexical`, ont tous été revérifiés sur `main` : aucun n'a disparu,
deux se sont élargis, un a été réfuté.

Conduite : **zéro appel à `Workflow`, zéro appel à `Agent`** (plafond de trois non
entamé). Tout a été établi en solo, par lecture et par mesure.

Les corrections sont suivies ci-dessous. L'audit lui-même n'a rien modifié : il a dit quoi
faire, et les pull requests le font.

Deux mesures ont demandé de modifier temporairement un fichier du dépôt (constats 3 et 4).
Les deux ont été restaurées par `git checkout` immédiatement après, et l'arbre de travail
est propre.

## Suivi des corrections

Une ligne par constat. Les corrections sont livrées en quatre pull requests, découpées par
type de commit conventionnel pour que le CHANGELOG et le calcul de version restent justes.

| # | Constat | Statut |
| --- | --- | --- |
| 1 | Section juridique décrivant un procédé périmé | corrigé, #28 |
| 2 | `horsControle` figé quel que soit le niveau | corrigé, #28 |
| 3 | Catalogue d'endpoints listé à la main | corrigé, #28 |
| 4 | Niveau `comptes` réécrivant le texte qu'il déclare intact | corrigé, #28 |
| 5 | Codes de sortie incohérents | corrigé, #29 |
| 6 | Progression et diagnostics sur stdout | corrigé, #29 |
| 7 | `since` absent du format | corrigé, #28 |
| 8 | Accumulations mémoire bornées par les messages | partiel, #28 |
| 9 | `MessageList` non mémoïsé | corrigé, #30 |
| 10 | Rappels recréés à chaque rendu | corrigé, #30 |
| 11 | Aucun `React.memo` | corrigé, #30 |
| 12 | Manques de la grille CLI | corrigé, #31 |
| 13 | Aucun `import()` dynamique | écarté, arbitrage mesuré |

**Constat 8, partiel et assumé.** Seul `identifiantsColles` est plafonné : c'était la
seule des trois structures à croître sans borne pour un bénéfice nul. `seenIds` sert aussi
à détecter les racines de fil orphelines, ce qui exige le canal entier, et son coût mesuré
est de 5 Mo sur le pire canal de l'archive de référence. `bundle.messages` est structurel
au mode de lecture du viewer.

**Constat 13, écarté.** `standardEmoji` est appelé de façon synchrone pendant le rendu du
Markdown : le différer impose soit un rendu asynchrone, soit un scintillement
`:shortcode:` sur chaque message. La table pèse 15,5 Ko gzip sur un bundle de 149,5 Ko,
soit 10 %. Dix pour cent du bundle ne valent pas ce scintillement, dans une application
qui charge déjà un wasm de 865 Ko en mode lite. Le constat reste ici pour que la décision
soit retrouvable, pas pour être repris tel quel.

**Sur le constat 5, l'audit s'était trompé par omission.** Il listait quatre binaires ;
il y en a cinq. `mmarchive-serve` sortait lui aussi en 1 sur une option inconnue, et c'est
la garde dérivée des `bin` déclarés, écrite en corrigeant, qui l'a trouvé. Une liste tenue
à la main, encore.

---

## 1. La section soumise au juridique décrit un procédé vieux de deux versions

**Gravité : garantie fausse dans le document qui engage.** C'est le constat le plus grave
de cet audit.

`docs/DECISION-ANONYMISATION.md:441` dit : « C'est cette section, et non la commande,
qu'il faut soumettre au juridique. » Elle décrit l'état du code avant le commit `28e0842`
(#25), qui a introduit les trois niveaux et fait de `noms` le défaut.

Trois affirmations sont fausses au niveau par défaut :

| Ligne | Ce que la doc affirme | Ce que le code fait |
| --- | --- | --- |
| 406 | « `anonymized.text_rewritten` liste les formes traitées, et `noms` n'y figure pas » | `anonymize-archive.ts:808` écrit `noms` dans les deux surfaces au niveau `noms`, et `anonymize.test.ts:587` l'assert |
| 424 | le texte des blocs `attachments` « est traité exactement comme le corps des messages, c'est-à-dire pas encore » | les deux surfaces sont réécrites depuis `930cfaa` (#24) ; le manifeste énumère `props.attachments` |
| 427 | n'est pas garanti « le corps des messages, qui porte encore mentions, noms écrits en clair et adresses » | mentions et adresses réécrites au niveau `formes`, noms au niveau `noms` |

Comment ça a été établi : `git log -L` sur la plage de la section montre qu'elle n'a plus
bougé depuis `930cfaa`, alors que `28e0842` a réécrit la section « Trois niveaux » juste
au-dessus. La phrase de la ligne 424 date même de `55b06aa` (#21). Le document se
contredit donc lui-même : sa ligne 286 annonce « Le défaut est `noms` », sa ligne 406
affirme que `noms` ne figure jamais au manifeste.

L'erreur va dans le sens prudent, elle ne promet pas trop. Mais un juriste qui lit cette
section conclut que l'archive n'est jamais diffusable, alors que le niveau par défaut vise
exactement la diffusion. La section est inutilisable en l'état.

Correction : réécrire la section par niveau. Ce qui est garanti au niveau `comptes`, ce
que `formes` ajoute, ce que `noms` ajoute, et ce qui reste hors de portée dans les trois
cas. Vérifier au passage que le chiffre de la ligne 425 (13 054 valeurs de `fields`,
1 896 champs de texte) correspond toujours à un critère qui a un sens maintenant que ces
champs sont réécrits.

---

## 2. Le contrôle résiduel affirme, quel que soit le niveau, que le texte n'est pas traité

**Gravité : garantie fausse, et celle-là est dans le code.**

`residual-check.ts:519-525` construit la liste `horsControle` comme une constante figée.
Sa première entrée : « le corps des messages, qui porte encore mentions, noms en clair et
adresses ».

Cette liste n'est pas un commentaire interne. Elle est imprimée dans la **synthèse**
(`report-render.ts:290`, section « Ce que ce rapport ne mesure pas ») et affichée à
l'opérateur en fin de run (`anonymize.ts:177`). C'est le document que
`DECISION-ANONYMISATION.md:365` désigne comme « ce qui permet de dire à un juriste ce qui
est garanti et ce qui ne l'est pas ».

Elle est exacte au niveau `comptes`, à moitié fausse au niveau `formes` (mentions et
adresses sont traitées, les noms restent), et fausse au niveau `noms`, qui est le défaut.

Comment ça a été établi : lecture croisée de `niveau.ts` (`reecritLesFormes`,
`reecritLesNoms`) et de la boucle de `anonymize-archive.ts:654-687`, puis exécution du
niveau `comptes` décrite au constat 4.

Une nuance à ne pas perdre en corrigeant : « hors contrôle » devrait vouloir dire « le
contrôle ne vérifie pas cette surface », pas « cette surface n'est pas traitée ». Le
contrôle mesure bel et bien le corps des messages (il y compte mentions, adresses,
téléphones, identifiants collés). Ce qu'il ne peut pas faire, c'est garantir qu'il n'y
reste rien. La formulation actuelle dit autre chose, et le dit faux.

Correction : dériver `horsControle` du niveau appliqué, comme `formesReecrites` le fait
déjà pour le manifeste. Au passage, le « 312 183 messages » de la ligne 521 est un chiffre
de l'archive de référence figé dans un outil générique : il sera faux chez tout autre
utilisateur. Vérifié exact sur l'archive de référence (voir « Cherché sans rien trouver »),
mais il n'a rien à faire dans un message que l'outil imprime chez quelqu'un d'autre.

---

## 3. Le test qui garde la hard rule 2 ne peut pas détecter ce qu'il promet d'attraper

**Gravité : test qui donne l'illusion inverse de la réalité.**

`endpoints.ts:226-229` promet : « Un test verifie que le catalogue n en contient pas
d autres : si quelqu un ajoute un endpoint mutant, le test casse et la relecture est
forcee. »

Le test est `read-only-guarantees.test.ts:76`. Il itère sur `everyEndpointCall()`
(ligne 21), qui est une **liste littérale maintenue à la main**, pas un parcours de `MM`.
Un endpoint mutant ajouté au catalogue et absent de cette liste ne casse rien.

Établi de deux façons.

D'abord la liste est **déjà désynchronisée** : le catalogue `MM` expose 22 méthodes,
`everyEndpointCall()` en cite 21. `MM.getTeam` n'est couvert par aucune des cinq
assertions de ce fichier.

Ensuite par exécution. J'ai ajouté au catalogue un `DELETE /channels/{channel_id}` déclaré
`mutates: true`, sans toucher au test. Résultat : `Test Files 1 passed, Tests 14 passed`.
Un endpoint capable de supprimer un canal entre dans le catalogue sans qu'aucune garde ne
bronche. Le fichier a été restauré par `git checkout` juste après.

Ce qui rend le constat net, c'est que le dépôt a déjà le bon patron ailleurs :
`tests/error-codes.test.ts:30` construit son inventaire en lisant les sources, et son
commentaire explique exactement pourquoi (« une classe oubliée n'est exportée par aucun
barrel, et c'est précisément celle qu'il faut attraper »).

Correction : dériver la liste de `Object.keys(MM)` par introspection, en invoquant chaque
méthode avec des arguments plausibles, plutôt que de l'écrire. Ajouter `getTeam` ne
suffit pas, ce serait recréer le même trou un cran plus loin.

---

## 4. Le niveau `comptes` réécrit le texte que son aide déclare intact

**Gravité : promesse fausse dans l'aide de la commande.**

`niveau.ts:44-45` décrit le niveau `comptes` : « Fiches de comptes, metadonnees et
references. Les binaires ne sont pas repris. **Le texte n est pas touche** : les mentions,
les adresses et les noms y restent en clair. » Cette chaîne est affichée par `--help`, par
`anonymize.ts:131` en début de run, et reprise en tête de la synthèse
(`report-render.ts:105`).

Or `anonymize-archive.ts:654` appelle `reecrireNomsDesignes(post, resolveur)`
inconditionnellement, avant tout test de niveau, et son résultat devient le corps du
message. La fonction traite tout message système, plus tout message dont `props` porte
`username`, `addedUsername` ou `removedUsername`.

Établi par exécution, sur la fixture des tests existants, au niveau `comptes` :

```text
messages au total : 8
messages dont le corps a change : 2
  type: "system_add_to_channel"
    avant : "alice.martin a ete ajoute au canal par bob."
    apres : "anon-quartz-ample a ete ajoute au canal par anon-basalte-agile."
```

La fixture comptait alors huit messages ; la correction lui en a ajouté un neuvième, qui
porte une mention, une adresse et un nom en clair, pour que les trois niveaux se
distinguent.

L'ordre de grandeur réel est dans `system-message.ts:5-8` : 65 577 messages système sur
67 401 portent un texte de ce type sur l'archive de référence. Au niveau censé ne pas
toucher au texte, ce sont donc des dizaines de milliers de corps de messages réécrits.

Le comportement lui-même est **correct et voulu**, `DECISION-ANONYMISATION.md:290`
l'explique bien : sans lui, le niveau le plus bas porterait la table de correspondance en
clair. C'est la description qui ment.

Aggravant : **aucun test n'exerce ce niveau.** Sur les 33 appels à l'assistant de test
`anonymiser()` de `anonymize.test.ts`, 31 sont au niveau `noms`, 1 au niveau `formes`,
0 au niveau `comptes`. Le niveau dont la promesse est la plus facile à casser est le seul
qui n'est jamais exécuté.

Correction : reformuler la description (« les mentions, les adresses et les noms écrits en
clair ne sont pas réécrits ; les noms que les métadonnées désignent le sont, à tous les
niveaux »), et ajouter un test au niveau `comptes` qui fixe cette frontière.

---

## 5. Code de sortie incohérent entre les binaires

**Gravité : documentation fausse.** Constat de la passe précédente, revérifié et élargi.

`README.md:520` promet : `0` succès, `1` échec, `2` argument invalide, `130` interruption.

Mesuré sur un argument inconnu (`--nawak`) :

| Binaire | Code observé |
| --- | --- |
| `mmarchive-extract` | 1 |
| `mmarchive-index` | 1 |
| `mmarchive-redact` | 2 |
| `mmarchive-anonymize` | 2 |

`redact.ts:28` et `anonymize.ts:46` posent un `exitOverride` ; ni `extractor/src/cli.ts`
ni `viewer/src/cli.ts` n'en ont, donc commander applique son code par défaut.

Le cas de `mmarchive-index` est le plus gênant, parce qu'il est incohérent avec lui-même :
son helper `entier()` (`viewer/src/cli.ts:13`) porte le commentaire « Code 2 : argument
invalide, comme le documente le README » et sort bien en 2 sur une valeur invalide, tandis
qu'une **option** inconnue sort en 1.

Correction : porter le même `exitOverride` dans les deux `cli.ts`, ou retirer la promesse
du README.

---

## 6. La progression et les diagnostics sortent sur stdout

**Gravité : documentation fausse.** Constat de la passe précédente, confirmé par mesure.

Deux promesses en cause. `README.md:517` : « la progression et les diagnostics vont sur la
sortie d'erreur, la sortie standard ne porte que le résultat ». `cli.ts:22` :
`-v, --verbose  Sortie detaillee, sur la sortie d erreur`.

Mesuré en instanciant le `Logger` réel et en séparant les deux flux dans des fichiers
distincts :

| Méthode | Flux réel |
| --- | --- |
| `debug` | stdout |
| `info` | stdout |
| `success` | stdout |
| `warn` | stderr |
| `error` | stderr |

Vérifié aussi sur une commande complète : `verify --archive <vide> -v` envoie le titre de
section et le chemin de l'archive sur stdout, la progression `[0s] ...` et les erreurs sur
stderr.

`--json` reste correct : `verify.ts:24` route explicitement le reste vers stderr pour que
`verify --json | jq` fonctionne.

Correction : router `debug`, `info`, `success` et `section` vers `#err`, et ne laisser sur
`#out` que ce qui est un résultat. Les deux promesses redeviennent vraies.

---

## 7. `options.since` est écrit dans le manifeste et absent du format

**Gravité : documentation incomplète sur un point normatif.**

`manifest.ts:173` déclare `since: isoDate.optional()` dans `options`, et
`orchestrator.ts:759-761` l'écrit effectivement quand `--since` est passé.

`docs/ARCHIVE_FORMAT.md` ne le mentionne **nulle part** : ni dans l'exemple JSON de la
section 4, ni dans le texte. Vérifié par `grep -n 'since'` sur tout le fichier, zéro
occurrence.

Or la section 14 du même document pose que les schémas zod « constituent la référence
exécutable de ce document : en cas de divergence, c'est un bug, à corriger des deux
côtés ». C'est le seul écart trouvé sur ce point, les sept enregistrements ayant été
comparés champ par champ par introspection des schémas.

Correction : ajouter `since` à la section 4, avec sa sémantique de borne basse
d'extraction incrémentale.

---

## 8. Accumulations mémoire bornées par les messages (HR7)

La hard rule 7 interdit le tampon mémoire global. Trois structures croissent avec les
messages plutôt qu'avec les comptes ou les canaux. Aucune n'est bloquante, et les trois
sont mesurées plutôt qu'estimées.

**`channel-posts.ts:128`, `seenIds`.** Un identifiant de post par message du canal, gardé
pour toute la durée de l'extraction du canal. Mesuré : sur le plus gros canal de l'archive
de référence (181 432 messages), le `Set` occupe **5,0 Mo**. Avec `--concurrency 16`, la
borne haute théorique est de l'ordre de 80 Mo, jamais atteinte en pratique puisqu'un seul
canal est de cette taille. Le commentaire de la ligne 172 justifie la déduplication par le
retour possible du post pivot d'une page à l'autre, ce qu'un tampon de la taille d'une
page couvrirait. Noter que `seenIds` sert aussi ligne 273 à détecter les racines de fil
orphelines, ce qui exige bien le canal entier : la réduction n'est donc pas gratuite.

**`residual-check.ts:448`, `identifiantsColles`.** Une entrée poussée par message portant
un identifiant de compte collé dans le corps, sans plafond. `report-render.ts:259` affirme
« Le volume est trivial », ce que le code ne garantit pas. Mesuré sur l'archive de
référence, avec `identifiantsDe` du dépôt : **7 messages, 11 occurrences**. Le chiffre
donne raison au commentaire aujourd'hui ; rien ne le tient demain sur une autre archive.

**`MessageList.tsx:63`, `bundle.messages`.** Le tampon grandit à chaque page chargée
(`loadMore` concatène) et ne redescend jamais dans une session. C'est structurel au mode
de lecture retenu, et c'est ce qui rend le constat 9 progressivement coûteux.

Correction : aucune n'est urgente. Si l'une doit bouger, c'est `identifiantsColles`, qui
se plafonne en une ligne, le rapport annonçant déjà un total séparé du détail.

---

## 9. `MessageList` refait tout son travail à chaque rendu

**Gravité : performance mesurée.** Constat de la passe précédente, revérifié : le fichier
n'a pas changé depuis le commit `349ae42` (#1), les lignes citées sont identiques.

`MessageList.tsx:78-79` et `150-161`. À chaque rendu : une copie triée de tous les
messages chargés, la reconstruction intégrale de `rows`, et deux `Map` d'index. Rien n'est
mémoïsé, et le virtualiseur déclenche un rendu à chaque frame de défilement.

Remesuré en exécutant le vrai `buildRows` extrait du fichier, avec les vrais `formatDay` /
`formatDate` importés de `data.tsx`, 50 itérations après chauffe :

| Messages chargés | Par rendu | Budget d'une frame à 60 fps |
| --- | --- | --- |
| 200 | 0,06 ms | 0 % |
| 1 000 | 0,24 ms | 1 % |
| 4 000 | 0,95 ms | 6 % |
| 10 000 | 2,82 ms | 17 % |
| 40 000 | 11,25 ms | 67 % |

Les chiffres sont environ deux fois plus bas que ceux de la passe précédente, sur un code
inchangé : c'est la machine et le protocole de mesure qui diffèrent, pas le code. La
conclusion ne bouge pas. La page vaut 50 messages (`queries.ts:186`), donc le seuil
gênant demande un défilement soutenu dans un gros canal, mais le coût croît linéairement
avec ce qui est chargé et ne redescend jamais.

Correction : `useMemo` sur les quatre calculs, avec `bundle.messages`, `bundle.reactions`
et `bundle.attachments` en dépendances.

---

## 10. Les rappels se recréent à chaque rendu

`App.tsx:115` passe `loadOlder` en fonction fléchée inline. `MessageList.tsx:143` la met
en dépendance de `loadMore`, qui dépend aussi de `messages`, recréé à chaque rendu. Donc
`loadMore` puis `onScroll` changent d'identité à chaque rendu, et toute mémoïsation en
aval est annulée d'avance.

`messages` n'y sert qu'à lire `messages[0]?.id` (ligne 126), qui se récupère dans le
`setState` fonctionnel déjà présent juste en dessous.

---

## 11. Aucun `React.memo` dans tout le frontend

Vérifié, zéro occurrence sur `packages/viewer/web/src`. `MessageRow` se re-rend à chaque
rendu de la liste, y compris quand ni son message ni ses réactions n'ont changé. Les
tableaux passés en props sont d'ailleurs recréés à chaque fois (`MessageList.tsx:196-197`,
`?? []`), donc un `memo` seul ne suffirait pas : il faut le constat 9 d'abord.

---

## 12. Grille CLI, les points restants

Périmètre : `mmarchive-extract`, `mmarchive-redact`, `mmarchive-anonymize`.
Bilan : 25 respectées, 3 partielles, 4 absentes, 9 non applicables. Les quatre absences
ci-dessous sont confirmées sur `main`.

**Pas de complétion shell (§3.7).** Cinq sous-commandes, une trentaine d'options, des
valeurs devinables (niveaux, modes). Aucune occurrence de `completion` dans les sources.

**Pas d'URL de rapport de bug (§6.5).** `docs/CODES-ERREUR.md` dit « merci de la signaler »
sur quatre codes (E2009, E2010, E3004, E3009) sans jamais dire où.

**La version n'apparaît pas dans les messages d'erreur (§9.4).** `TOOL_VERSION` alimente
`--version` et le manifeste, aucun message d'erreur ne la porte.

**`--json` limité à `verify` (§3.2).** Une seule occurrence dans tout l'extracteur
(`cli.ts:107`). Le viewer est mieux loti : `build`, `plan-chunks` et `chunks` l'ont tous.
`inventory` et `doctor` produisent des résultats structurables sans équivalent.

**`localeCompare` sans locale (détail).** `channel-posts.ts:169` sert au départage de la
pagination keyset sur des identifiants `[a-z0-9]`, risque théorique.
`build-inventory.ts:160` passe bien `"fr"`, donc c'est le seul cas.

---

## 13. Aucun `import()` dynamique dans le frontend (faible)

La table d'emojis fait 40 Ko de source et part dans le bundle principal, alors qu'elle ne
sert qu'au rendu d'un message contenant un `:nom:`. Bundle principal : 411 Ko brut,
146 Ko gzip, ce qui reste raisonnable.

Le mode lite échappe déjà au problème : le worker sqlite (290 Ko) et son wasm (865 Ko)
sont dans des chunks séparés, chargés seulement quand ce mode est choisi.

---

## Cherché sans rien trouver

### Hard rules

- **HR1, canaux publics.** Aucune comparaison `=== "O"` hors de `shared`, tout passe par
  `isPublicChannel`.
- **HR2, aucun join implicite.** `assertReadOnly` couvre les deux chemins publics de
  `http-client.ts` (`json` ligne 212, `binary` ligne 228) ; `execute` et `send` sont
  privés. `createRawExecutor` n'a qu'un seul appelant, `orchestrator.ts:203`, qui
  construit la `MutationGate`. Les deux POST non mutants du catalogue (`/users/ids`,
  `/posts/ids/reactions`) sont des lectures légitimes et déclarées comme telles. La
  `MutationGate` refuse tout canal hors consentement et refuse de quitter un canal qu'elle
  n'a pas rejoint. Ce qui est en cause au constat 3, c'est le test, pas la garde.
- **HR3, viewer en lecture seule.** Aucune route `post` / `put` / `delete` / `patch`.
- **HR4 et HR5, séparation données / viewer.** Aucun import `mattermost` ni
  `@mmarchive/extractor` dans le viewer. Les deux lecteurs d'archive vérifient
  `schema_version` et refusent une version supérieure (`checks.ts:130`, `build.ts:147`),
  ce que la section 13 du format exige.
- **HR7.** Les accumulations de `anonymize-archive.ts` (435, 438, 448, 466-475, 531) sont
  toutes bornées par le nombre de comptes, 3 277 sur l'archive de référence, et le
  commentaire de la ligne 525 l'assume explicitement. `compterFrequences` retourne une
  `Map` bornée par les formes candidates, donc par les comptes. Toute la boucle des posts
  est en flux, écriture comprise. Voir le constat 8 pour les trois exceptions réelles.

### Interdits

- **Aucun fichier sensible versionné.** `git ls-files` (209 entrées) ne contient ni
  archive, ni `channels.yaml`, ni `index.db`, ni fichier d'environnement autre que
  `.env.example`. Vérifié sur le contenu réel de l'index, pas sur ce que `.gitignore`
  annonce.
- **Aucune trace du contexte d'origine.** Les 28 hôtes cités dans le dépôt versionné sont
  soit des exemples (`example.org`, `example.com`, `exemple.test`), soit des domaines
  publics légitimes. Le nom de team réel et l'hôte de l'instance, lus dans l'archive
  locale, n'apparaissent dans aucun fichier versionné. Les 13 chaînes de 26 caractères
  présentes dans les sources sont toutes synthétiques (`aaa…`, `abcdef…`) et aucune ne
  correspond à un identifiant réel de `channels.ndjson` ou `users.ndjson`.

### Documentation contre code

- **Les sept enregistrements du format.** `post`, `user`, `channel`, `team`, `emoji`,
  `file` : concordance complète entre les clés des schémas zod et les sections 5 à 10,
  vérifiée par introspection des `shape` zod contre les blocs JSON et les identifiants en
  backticks de chaque section. Les deux champs optionnels (`user.email`,
  `file.skip_reason`) sont documentés comme tels.
- **Les codes d'erreur.** 27 codes dans `shared/src/errors.ts`, 27 dans
  `docs/CODES-ERREUR.md`, aucun écart dans un sens ni dans l'autre.
- **Les options du README.** Toutes les options citées existent dans l'un des quatre
  binaires, `--index` compris (il est déclaré dans `serve.ts:15`, pas dans
  `viewer/src/cli.ts`).
- **Les scripts pnpm.** Tous ceux cités par `README.md`, `CLAUDE.md` et `docs/` existent
  dans `package.json`.
- **L'absence du fichier d'état après anonymisation.** La section 11 du format l'affirme.
  Vérifié : `anonymize-archive.ts` accepte `.extract-state.json` en entrée
  (`RACINE_ATTENDUE`) et ne l'écrit jamais en sortie.
- **Le chiffre de CLAUDE.md sur la sélection.** « 758 canaux extraits dont 88 déjà membre,
  aucun rejoint » : confirmé mot pour mot par `manifest.json` de l'archive de référence.

### Chiffres de l'anonymisation vérifiés sur l'archive

Mesurés en une passe sur les 1 892 791 messages, en important le code du dépôt plutôt
qu'en le réimplémentant.

- « Onze identifiants de comptes réels collés dans le corps de sept messages » : **exact**,
  7 messages et 11 occurrences.
- « `vanessa` désigne quatre comptes » : **exact**, 4 comptes.
- « 312 183 messages » que vider le texte des blocs viderait : **exact**, à condition de
  compter les messages dont le corps est vide ET qui portent des blocs. Mon premier
  comptage, sur le critère « porte des blocs », donnait 322 964 ; c'est mon critère qui
  était faux, pas le chiffre du dépôt. C'est exactement le piège que la procédure signale.

### Anonymisation, garanties qui tiennent

- **La synthèse ne porte aucune chaîne d'origine.** Lue en entier : elle n'imprime que des
  nombres, des parts et des libellés fixes. Les identifiants d'emplacement (`postId`,
  `canal`) ne sortent que par `rendreReleve`, écrit sous le nom
  `releve-ne-pas-diffuser-*.ndjson`, ce que la section « Ce que le rapport ne dira jamais »
  autorise explicitement.
- **Le verdict n'est jamais positif.** Deux valeurs seulement, `non_diffusable` avec sa
  cause ou `sans_avis`, et la cause ne cite aucune valeur trouvée.
- **Le seuil d'effectif est appliqué au formatage.** `effectifPublic` fond tout effectif
  sous 5, `partPublique` limite la précision d'un taux pour qu'il ne soit pas un
  numérateur déguisé.
- **Le rapport s'écrit avant de lever.** `anonymize.ts:151` : le chemin où le contrôle
  échoue est précisément celui où le rapport est indispensable, et il est produit.
- **La substitution des noms désignés par les métadonnées s'applique à tous les niveaux**,
  comme le cadrage l'exige. C'est vrai, et c'est ce qui rend fausse la description du
  niveau `comptes` (constat 4).
- **Les références orphelines sont retirées et non repliées sur l'identifiant d'origine**,
  et comptées par catégorie.

### Tests

- **881 tests dans 43 fichiers.** Recherche systématique des motifs coûteux : assertions
  sur une référence de fonction non appelée, `expect(x.method)` sans appel, tests sans
  aucune assertion. Les seuls candidats remontés sont des faux positifs (les deux tests de
  `paths.test.ts` sans `expect` visible délèguent à l'assistant `expectSafeName`).
  34 assertions faibles au total, toutes en complément d'une assertion plus fine.
- **Le simulateur d'extraction ne reproduit plus l'hypothèse du code.** Le
  commentaire d'ouverture de `tests/integration/extraction.integration.test.ts` documente
  précisément le piège passé (`header`, `purpose`, `create_at` écrits en dur et un
  simulateur qui ne les renvoyait pas davantage) et le test tourne maintenant contre un
  vrai serveur, gardé par `MM_INTEGRATION_URL` donc hors de `pnpm test`.
- **`tests/error-codes.test.ts` est le bon patron.** Il dérive son inventaire des sources
  au lieu de le lister, y compris pour les points d'entrée qu'il déduit des `bin` déclarés.

### Divers

- **Injection d'arguments (§10.1)** : aucun `child_process` dans tout l'extracteur.
- **Interactivité (§3.5)** : `isInteractive` exige un TTY des deux côtés, plus l'absence
  de CI, plus `--no-input`.
- **Précédence de configuration (§3.4)** : `firstNonEmpty(raw.url, env.MM_URL)`, la ligne
  de commande avant l'environnement.
- **Signaux (§1.8)** : `SIGINT` et `SIGTERM` traités dans `orchestrator.ts:199`, retirés
  en fin de run.
- **Locales (§5.1)** : toutes les sorties figent `fr-FR`, et `run-reporter.test.ts:35`
  documente même le piège de l'espace insécable étroite U+202F.
- **Shebang (§4.4)** : `#!/usr/bin/env node` injecté par le banner tsup.
- **Couleurs (§1.4)** : `NO_COLOR`, `--no-color`, `FORCE_COLOR`, détection TTY.
- **Options globales de commander** : `--verbose` est bien pris avant comme après la
  sous-commande.
- **JSX conditionnel** : aucun `&&` dans le JSX, que des ternaires.
- **Composants imbriqués** : aucun composant défini dans un composant.
- **Télémétrie (§8.1)** : aucune, ce qui est la bonne réponse.

### Réfuté par rapport à la passe précédente

- **Le commentaire de `http-client.ts:240`.** La passe précédente relevait qu'il affirme
  que l'exécuteur brut « n est jamais expose publiquement » alors que `createRawExecutor()`
  est une méthode publique. C'est exact au sens de TypeScript, mais la phrase se lit dans
  son contexte (« Fabrique l executeur brut confie a MutationGate. C est le SEUL chemin
  vers une requete mutante ») et cette partie-là est vraie et vérifiée. Le durcir en
  constat serait durcir la promesse. Retiré.
