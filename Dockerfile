# syntax=docker/dockerfile:1.7

# ── build the renderer ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# The child-registry tests read process groups with `ps`; bookworm-slim omits
# procps. Keep this in the build stage so the runtime image stays unchanged.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

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

# ── production dependencies ───────────────────────────────────────────
# The runtime used to ship no node_modules because the server only needed
# built-ins. Backups added yazl/unzipper to `electron/backup-store.cjs`, which
# rpc requires at boot, so the image needs the production tree — not the dev
# tooling from the build stage.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

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

# The shared `electron/*.cjs` modules are plain CommonJS (the optional Electron
# require is guarded), but they do require runtime packages: `yazl` and
# `unzipper` for backups are loaded through rpc at boot. Ship the production
# tree only — no Vite, no Playwright, no electron-builder.
COPY --from=build --chown=entity:entity /app/dist ./dist
COPY --chown=entity:entity server ./server
COPY --chown=entity:entity electron ./electron
COPY --from=prod-deps --chown=entity:entity /app/node_modules ./node_modules

USER entity
EXPOSE 1020
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1020/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# `init: true` in compose is the tini; this process handles SIGTERM itself and
# stops any harness child before exiting.
CMD ["node", "server/index.cjs"]
