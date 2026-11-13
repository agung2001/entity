# syntax=docker/dockerfile:1.7

# ── build the renderer ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# The lockfile is the only thing that decides versions; `npm ci` fails loudly
# instead of quietly installing a different tree than the one that was tested.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html vite.config.js jsconfig.json ./
COPY public ./public
COPY src ./src
# vite.config.js resolves the shared call-table modules at build time, so the
# same `electron/*.cjs` files the runtime uses must be present in this stage.
COPY electron ./electron
RUN npm run build

# ── run the server ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ENTITY_HOME=/data \
    ENTITY_HOST=0.0.0.0 \
    ENTITY_PORT=1020

RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 entity \
 && useradd --uid 10001 --gid entity --create-home --shell /usr/sbin/nologin entity \
 && mkdir -p /app /data \
 && chown -R entity:entity /data

WORKDIR /app

# The server only needs Node built-ins plus the shared `electron/*.cjs` modules
# (they are plain CommonJS; the optional Electron require is guarded). Copying
# `dist` means no build tooling, no dev dependencies and nothing to `npm install`
# at runtime.
COPY --from=build --chown=entity:entity /app/dist ./dist
COPY --chown=entity:entity server ./server
COPY --chown=entity:entity electron ./electron

USER entity
EXPOSE 1020
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1020/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# `init: true` in compose is the tini; this process handles SIGTERM itself and
# stops any harness child before exiting.
CMD ["node", "server/index.cjs"]
