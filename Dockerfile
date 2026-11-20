# syntax=docker/dockerfile:1
# OSFPM development and test image.
# There is no HTTP server yet, so this image runs the test suite.
# A production image (API + worker) comes once the HTTP framework is chosen.

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# Node.js 25+ no longer ships Corepack. Install it so pnpm matches
# the "packageManager" field in package.json.
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app
RUN chown node:node /app
USER node

# Download every package in the lockfile once; cached between builds.
FROM base AS deps
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=osfpm-pnpm-store,target=/home/node/.pnpm-store,uid=1000,gid=1000 \
    pnpm fetch --frozen-lockfile --store-dir /home/node/.pnpm-store

# Copy the source and install from the cached store. --prefer-offline uses the
# network only for packages the cache no longer has (BuildKit can prune it), so a
# pruned cache makes the build slower instead of failing it.
FROM deps AS test
COPY --chown=node:node . .
RUN --mount=type=cache,id=osfpm-pnpm-store,target=/home/node/.pnpm-store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile --prefer-offline --store-dir /home/node/.pnpm-store
CMD ["pnpm", "test"]
