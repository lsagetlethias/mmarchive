# syntax=docker/dockerfile:1.10

# Image du viewer seul. L extracteur n est pas ici : il tourne une fois, sur un
# poste, avec un token qui ouvre l instance en ecriture. Mettre les deux dans la
# meme image reviendrait a promener ce pouvoir sur le serveur de consultation.
#
# Node 24 fournit node:sqlite : l index se lit sans dependance native, donc sans
# chaine de compilation, ni au build ni a l execution.

ARG NODE_TAG=24-slim

FROM node:${NODE_TAG} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Les manifestes avant les sources : tant qu ils ne bougent pas, la couche
# d installation est reutilisee et un changement de code ne retelecharge rien.
FROM base AS manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/extractor/package.json packages/extractor/
COPY packages/viewer/package.json packages/viewer/

FROM manifests AS build
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @mmarchive/viewer build

# Dependances d execution seules. Le bundle du serveur n importe que fastify,
# @fastify/static, commander, picocolors, yazl et zod : React et sqlite-wasm
# sont des outils de construction du frontend, deja inlines dans web/dist.
#
# Tout bundler pour supprimer ce niveau a ete essaye et abandonne : commander est
# en CommonJS et son require("node:events") ne survit pas a la conversion en ESM.
#
# node-linker=hoisted produit un node_modules a plat, sans lien symbolique vers
# le magasin virtuel, donc copiable tel quel. Le hissage ignore le filtre et
# ramene aussi les quelques paquets de l extracteur ; ils sont inertes, rien ne
# les importe, et les separer demanderait un lockfile par paquet.
FROM manifests AS runtime-deps
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @mmarchive/viewer \
      --node-linker=hoisted

FROM node:${NODE_TAG} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/viewer/dist ./dist
COPY --from=build /app/packages/viewer/web/dist ./web/dist
COPY --from=build /app/packages/viewer/web/dist-standalone ./web/dist-standalone

# L archive et l index sont montes sous /data, en lecture seule. Ils ne sont
# jamais copies dans l image : 27 Go de donnees internes n ont rien a faire dans
# un artefact qui se pousse sur un registre.
#
# Pas de VOLUME ["/data"] pour autant. Les montages portent sur ses sous
# repertoires, jamais sur lui : la declaration ne ferait que creer un volume
# anonyme de plus a chaque lancement, orphelin des le suivant. Mesure a un par
# cycle. La donnee vient toujours de montages explicites, et le process n ecrit
# jamais.

USER node
EXPOSE 4173

# /api/meta interroge reellement l index : le controle prouve que le serveur
# repond ET que sa base est lisible, la ou une simple ouverture de port ne dirait
# rien. Le compte porte sur plus d un million de messages en moins de dix
# millisecondes, le cout est negligeable a cette cadence.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/meta').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# L ecoute est sur toutes les interfaces parce qu un conteneur n est joignable
# qu a cette condition. La protection se joue donc dehors : publication du port
# sur la boucle locale et mandataire inverse. Voir docs/DEPLOIEMENT.md.
ENTRYPOINT ["node", "/app/dist/serve.js", \
    "--web", "/app/web/dist", \
    "--standalone", "/app/web/dist-standalone/archive.html", \
    "--host", "0.0.0.0"]
CMD ["--index", "/data/index/index.db", "--archive", "/data/archive"]
