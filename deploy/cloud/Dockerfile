# IvoryOS Cloud -- one image, run as two services (see docker-compose.yml): the Next web app and the
# daemon that owns the MQTT connection. Same code, same version, different command.
#
# Build context is the REPOSITORY ROOT, not this folder: the app is an npm workspace and imports
# @ivoryos/shared-ui from packages/, which a cloud_frontend-only context cannot see.
#
#   docker compose -f deploy/cloud/docker-compose.yml up -d --build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Manifests first, so dependency install is cached until a package.json or the lockfile changes.
# frontend/package.json is only needed because npm validates every workspace the root lists.
COPY package.json package-lock.json ./
COPY cloud_frontend/package.json cloud_frontend/
COPY packages/shared-ui/package.json packages/shared-ui/
COPY frontend/package.json frontend/
RUN npm ci --workspace cloud_frontend --workspace packages/shared-ui --no-audit --no-fund
# Tailwind and lightningcss need a native binary for *this* platform, and a lockfile written on
# another OS can omit it (npm/cli#4828) -- the build then fails with "Cannot find native binding".
# Install the ones matching this machine, at exactly the versions the lockfile resolved.
RUN cd cloud_frontend \
 && ARCH="$(node -p process.arch)" \
 && npm install --no-save --no-audit --no-fund \
      "@tailwindcss/oxide-linux-${ARCH}-gnu@$(node -p "require('@tailwindcss/oxide/package.json').version")" \
      "lightningcss-linux-${ARCH}-gnu@$(node -p "require('lightningcss/package.json').version")"

FROM deps AS build
COPY packages/shared-ui packages/shared-ui
COPY cloud_frontend cloud_frontend
RUN npm run build --workspace cloud_frontend

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # LAN mode's SQLite file, on the volume both services mount (see docker-compose.yml).
    IVORYOS_LOCAL_DB=/data/ivoryos_cloud.db
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/cloud_frontend
# 3000: web app. 1883: the daemon's embedded MQTT broker (LAN mode only).
EXPOSE 3000 1883
# `next` is resolved rather than hard-coded: npm may place it under cloud_frontend/ or the root.
# `exec` so node is PID 1's direct child under `init: true` and receives stop signals itself.
CMD ["sh", "-c", "exec node \"$(node -p \"require.resolve('next/dist/bin/next')\")\" start -p 3000"]
