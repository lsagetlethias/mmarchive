# Traverser un proxy d'authentification

Utilitaire local, hors de mmarchive, pour le cas où l'instance est derrière un proxy
d'authentification type [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy).

## Le symptôme

```
[E2003] GET /users/me a repondu 401 : {}
```

Ce n'est pas `MM_TOKEN` qui a expiré. Le proxy intercepte avant Mattermost et répond `401`
aux requêtes `Accept: application/json`, `403` avec une page de connexion aux autres. Le
signe qui tranche est l'absence de l'en-tête `x-version-id`, que Mattermost pose sur toutes
ses réponses, erreurs comprises.

## Utilisation

Récupérez le cookie dans les outils de développement, onglet **Network**, ligne `cookie:`
des Request Headers. **Pas l'onglet Application** : sa grille tronque les valeurs longues et
la copie récupère l'affichage, pas la valeur stockée.

```bash
MMPROXY_UPSTREAM=https://mattermost.example.org \
MMPROXY_COOKIE="$(pbpaste)" \
node --import tsx oauth2-proxy/relay.ts
```

Le relais sonde les deux étages au démarrage, le proxy puis Mattermost, et affiche les noms
et longueurs des cookies sans jamais leur valeur. Pointez ensuite mmarchive dessus :

```bash
pnpm mm:run --url http://127.0.0.1:8787 --file channels.yaml
```

Il n'ajoute que le cookie : le `Authorization: Bearer` de mmarchive traverse intact et reste
ce qui authentifie auprès de Mattermost.

| Variable              | Rôle                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `MMPROXY_UPSTREAM`    | URL de l'instance. Obligatoire.                                    |
| `MMPROXY_COOKIE`      | En-tête `Cookie` complet. Obligatoire, sauf `MMPROXY_COOKIE_FILE`. |
| `MMPROXY_COOKIE_FILE` | Le même en-tête, lu depuis un fichier.                             |
| `MMPROXY_PORT`        | Port local. `8787` par défaut.                                     |
| `MMPROXY_BEARER`      | Force le jeton si le proxy réécrit `Authorization`.                |

## Limites

La session a une durée de vie. Le relais suit son renouvellement si le proxy en émet un,
sinon une extraction longue s'interrompra : calibrez avec `doctor` et reprenez avec
`run --resume`. L'archive ne risque rien, le proxy répond `401` ou `403` et jamais `200`
avec du HTML, donc le client s'arrête au lieu d'écrire une page de connexion à la place
d'une pièce jointe.

Le cookie est un secret de session, ne le commitez pas. C'est aussi pourquoi le relais vit à
côté de mmarchive et non dedans : l'extracteur n'a jamais cette valeur à manipuler.
