# syntax=docker/dockerfile:1.7
#
# One image recipe for every Pactora service:
#
#   docker build --build-arg SERVICE=@pactora/api -t pactora-api .
#
# SERVICE is the workspace package: @pactora/api, @pactora/signer,
# @pactora/indexer, or an agent (@pactora/research-bot, …). The chain facts the
# config loader reads — networks, parameters, deployed addresses, ABIs — come
# from `chain/`, a committed copy of pactora-contracts-near kept exact by
# `scripts/sync-chain-facts.mjs` (CI fails on drift). That is what lets a
# hosted build that clones one repo (Railway) build at all, and an image
# always carries the exact deployment it was built against.
#
# To build against a live pactora-contracts-near checkout instead, replace the
# `contracts` stage with a named context:
#   --build-context contracts=../pactora-contracts-near
#
# The runtime stage holds only the service and its production dependencies,
# runs as the unprivileged `node` user, and has no build tools, no source
# maps' worth of source tree beyond what the package ships, and no .env.

ARG NODE_VERSION=22.12

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# The pinned pnpm (package.json `packageManager`), installed with npm: the
# corepack shipped with this Node carries npm registry signing keys that have
# since been rotated, so `corepack enable` fails to verify pnpm.
RUN npm install -g pnpm@9.12.0 --no-fund --no-audit
WORKDIR /repo

# The default chain facts: chain/ in this repo. A named build context called
# `contracts` replaces this stage entirely.
FROM scratch AS contracts
COPY chain/ /

FROM base AS build
ARG SERVICE
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
# Only this service and what it depends on ("…" = its workspace dependencies),
# one package at a time. `pnpm -r build` compiled all 14 packages in parallel
# in every image; concurrent `tsc -b` over shared project references raced and
# intermittently segfaulted or hung (seen building the worker images).
RUN test -n "${SERVICE}" || (echo "build-arg SERVICE is required" && exit 1) \
 && pnpm --filter "${SERVICE}..." --workspace-concurrency=1 build
# A self-contained copy of one service with production dependencies only.
RUN pnpm --filter "${SERVICE}" --prod deploy /out

FROM node:${NODE_VERSION}-alpine AS runtime
# UV_THREADPOOL_SIZE: DNS lookups run on libuv's pool (default 4). A dependency
# whose name stops resolving holds a thread for seconds per lookup; 16 keeps
# one dead neighbour from starving every other outbound call.
ENV NODE_ENV=production \
    PACTORA_CONTRACTS_ROOT=/contracts \
    UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=contracts --chown=node:node config /contracts/config
COPY --from=contracts --chown=node:node deployments /contracts/deployments
COPY --from=contracts --chown=node:node export /contracts/export
# Which code this image is. Railway passes RAILWAY_GIT_COMMIT_SHA to builds
# from GitHub; CI and local builds pass GIT_SHA. /health and /v1/status read
# this file (packages/service/src/build.ts), which accepts only a hex commit
# and an ISO time — anything else reads "unknown".
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GIT_SHA="${RAILWAY_GIT_COMMIT_SHA}"
RUN printf '{"commit":"%s","builtAt":"%s"}\n' "${GIT_SHA}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /app/build-info.json
USER node
# SIGTERM reaches node directly (exec form), so the service's own graceful
# shutdown runs: stop accepting, drain, close pools.
CMD ["node", "dist/main.js"]
