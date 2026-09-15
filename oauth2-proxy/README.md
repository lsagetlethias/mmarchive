# Traverser un proxy d'authentification

Ce dossier ne fait pas partie de mmarchive. C'est un utilitaire autonome, à usage local,
pour le cas où l'instance Mattermost à archiver est placée derrière un proxy
d'authentification, par exemple [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy).
mmarchive n'en sait rien et n'a pas été modifié pour lui.

## Le symptôme, et pourquoi il ment

L'extraction s'arrête sur une erreur qui accuse le mauvais coupable :

```
[E2003] GET /users/me a repondu 401 : {}
```

On en conclut que `MM_TOKEN` a expiré. C'est faux. Un proxy d'authentification intercepte
la requête **avant** Mattermost, et sa réponse dépend de l'en-tête `Accept` :

| Ce que la requête demande | Ce que le proxy répond          |
| ------------------------- | ------------------------------- |
| `application/json`        | `401` avec un corps `{}`        |
| `text/html` ou `*/*`      | `403` avec une page de connexion |

mmarchive demande du JSON pour les appels d'API, d'où le `401`. Le jeton Mattermost n'y est
pour rien : le proxy l'ignore, ce n'est pas une identité qu'il sait valider.

**Le signe qui tranche est l'absence de l'en-tête `x-version-id`.** Mattermost le pose sur
toutes ses réponses, y compris ses erreurs. Une réponse sans lui n'a jamais atteint
Mattermost. C'est plus fiable que le code de statut, et c'est ce que le relais contrôle.

## Ce que fait le relais

Il écoute sur `127.0.0.1`, relaie chaque requête vers l'instance réelle en y ajoutant
l'en-tête `Cookie` d'un navigateur déjà authentifié, et renvoie la réponse telle quelle.
mmarchive pointe dessus avec `--url` et ne voit qu'une instance ordinaire.

Trois détails qui ne sont pas cosmétiques :

- Il n'ajoute **que** le cookie. Le `Authorization: Bearer <MM_TOKEN>` de mmarchive traverse
  intact et reste ce qui authentifie auprès de Mattermost. La façade ne concerne que le
  proxy.
- Il absorbe les `Set-Cookie` de l'amont pour suivre le renouvellement de session. Une
  extraction dure plus longtemps que la session initiale.
- Il n'obéit à aucune redirection (`redirect: "manual"`). Sans cela, une `302` vers le
  fournisseur d'identité serait suivie jusqu'à une page de connexion renvoyée en `200`, que
  l'extracteur prendrait pour une réponse légitime et écrirait dans l'archive.

## Récupérer le cookie de session

Connectez-vous à l'instance dans un navigateur, puis outils de développement, onglet
**Network**. Cliquez n'importe quelle requête vers l'instance, section **Request Headers**,
puis copiez la valeur entière de la ligne `cookie:`.

**N'utilisez pas l'onglet Application.** La grille des cookies y tronque les valeurs longues
au rendu, et la copie récupère ce qui est affiché, pas ce qui est stocké. Un cookie de
session oauth2-proxy portant une identité OIDC fait couramment près de deux mille
caractères. La valeur tronquée est ensuite rejetée sans que rien ne dise pourquoi.

Copier l'en-tête entier plutôt qu'un cookie choisi à la main a deux avantages : les morceaux
d'une session découpée (`_oauth2_proxy_0`, `_oauth2_proxy_1`, au delà de 4 Ko) viennent tous,
et le `MMAUTHTOKEN` de Mattermost vient avec, ce qui sert de second chemin d'authentification
si le proxy réécrit l'en-tête `Authorization`.

## Utilisation

```bash
MMPROXY_UPSTREAM=https://mattermost.example.org \
MMPROXY_COOKIE="$(pbpaste)" \
node --import tsx oauth2-proxy/relay.ts
```

`pbpaste` évite de faire passer le cookie par l'historique du shell. Sous Linux, utilisez
`xclip -o` ou `wl-paste`, ou bien `MMPROXY_COOKIE_FILE`.

Au démarrage, le relais diagnostique la traversée en deux étages avant d'écouter :

```
--- cookies charges ---
_oauth2_proxy             1884 caracteres

--- etage 1 : le portier ---
GET /oauth2/auth  : 202
session           : VALIDE (utilisateur@example.org)

--- etage 2 : Mattermost ---
GET /users/me     : 200
x-version-id      : 10.12.4...
compte            : alice (4g5y7wzh5f8euchwpwqg8du9ww)
resultat          : OK, la traversee fonctionne
```

L'étage 1 interroge `/oauth2/auth`, l'endpoint dont c'est la seule fonction : dire si la
session présentée est valide. Il sépare « mon cookie franchit le proxy » de « Mattermost
accepte mon jeton », deux questions que le `401` du proxy confond en une seule. L'inventaire
n'affiche jamais une valeur de cookie, seulement les noms et les longueurs, ce qui suffit à
reconnaître une troncature.

Ensuite, pointez mmarchive sur le relais :

```bash
pnpm mm:doctor --url http://127.0.0.1:8787 --file channels.yaml
pnpm mm:run    --url http://127.0.0.1:8787 --file channels.yaml
```

## Variables d'environnement

| Variable              | Rôle                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `MMPROXY_UPSTREAM`    | URL réelle de l'instance. Obligatoire.                                 |
| `MMPROXY_COOKIE`      | En-tête `Cookie` complet. Obligatoire, sauf si `MMPROXY_COOKIE_FILE`.  |
| `MMPROXY_COOKIE_FILE` | Chemin d'un fichier contenant cet en-tête, au lieu de la variable.     |
| `MMPROXY_PORT`        | Port d'écoute local. `8787` par défaut.                                |
| `MMPROXY_BEARER`      | Force le jeton Mattermost si le proxy réécrit `Authorization`.          |

Le cookie est un secret de session : il ne doit jamais être commité, ni finir dans un
manifeste d'archive ou un fichier d'état. C'est aussi pourquoi le relais vit à côté de
mmarchive et non dedans, l'extracteur n'a ainsi jamais cette valeur à manipuler.

## Limites

La session a une durée de vie. Le relais suit son renouvellement si le proxy en émet un,
mais si l'expiration est absolue, une extraction longue s'interrompra en route. Deux
parades : calibrer avec `doctor` pour raccourcir le run, et reprendre avec
`mmarchive-extract run --resume`.

Une interruption ne corrompt pas l'archive. Le proxy répond `401` ou `403`, jamais `200`
avec du HTML, donc le client considère l'appel en échec et s'arrête, au lieu d'écrire une
page de connexion à la place d'une pièce jointe.

Enfin, aucune de ces manipulations ne contourne une autorisation : elle rejoue une session
que vous détenez déjà. Les règles de mmarchive restent entières, à commencer par le fait
qu'aucun canal n'est rejoint sans votre accord nominatif.
