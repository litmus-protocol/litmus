# syntax=docker/dockerfile:1.7
# Litmus Protocol: one Dockerfile, three runnable targets (web, gateway, runner).
#
#   docker build --target runner  -t litmus-runner  .
#   docker build --target gateway -t litmus-gateway .          # lean, no CRE
#   docker build --target gateway-cre -t litmus-gateway-cre .  # + cre CLI, bun, auditor workflow
#   docker build --target web     -t litmus-web \
#       --build-arg NEXT_PUBLIC_GATEWAY_URL=https://api.litmusprotocol.com \
#       --build-arg NEXT_PUBLIC_PRIVY_APP_ID=... \
#       --build-arg NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=... .
#
# Deploying to an amd64 server from an Apple-silicon Mac: add `--platform linux/amd64`.
#
# Build context is the repo root (pnpm workspace; every app depends on @defect/shared).
# Secrets are never baked in: .dockerignore excludes every .env file, so pass them at runtime.
#
# Layout: compilers, curl, pnpm, node_modules and the SEA tooling live only in throwaway build stages.
# gateway and runner ship as ONE self-contained executable each (esbuild bundle injected into a Node 25
# Single Executable Application, which is the first Node line that supports ESM + top-level await in SEA).
# No node_modules, no pnpm, no tsx in those images. The gateway additionally gets two static
# binaries (cre, bun) for the CRE auditor. web cannot be a binary: it ships Next's standalone output.

ARG NODE_VERSION=22
ARG NODE_SEA_VERSION=25
ARG ESBUILD_VERSION=0.25.10
ARG POSTJECT_VERSION=1.0.0-alpha.6
ARG BUN_VERSION=1.3.5
ARG CRE_VERSION=v1.39.0
# SHA-256 of the cre_linux_<arch>_ldd2-35.tar.gz release assets (smartcontractkit/cre-cli checksums.txt).
# We use the "ldd2-35" build: the default one needs glibc 2.38 and Debian bookworm ships 2.36.
# Update both whenever CRE_VERSION changes.
ARG CRE_SHA256_AMD64=398ca2c354d1814767583753dab226e08370d5ecc11589f50f8833fbf1607ed4
ARG CRE_SHA256_ARM64=c9451ba42031aee74085e70db15c40b815bc691c24a34c5a383875066c5a9a27

# ---------------------------------------------------------------- base (runtime + build)
FROM node:${NODE_VERSION}-bookworm-slim AS base
# COREPACK_HOME is world-readable so the non-root `node` user can run pnpm without re-downloading it.
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/opt/corepack \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate && chmod -R a+rX /opt/corepack
WORKDIR /app

# ---------------------------------------------------------------- deps (build stage only)
# Install the whole workspace from manifests first so this layer caches until a dependency changes.
# devDependencies are kept on purpose: gateway, runner and bot start through `tsx`.
FROM base AS deps
# Some transitive deps (e.g. utf-8-validate, an optional dep of ws) compile a native addon when no
# prebuilt binary matches, which needs python3, make and g++. None of this reaches the final images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/gateway/package.json apps/gateway/
COPY apps/runner/package.json apps/runner/
COPY apps/breaker-bot/package.json apps/breaker-bot/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- cre-bin (build stage only)
# Fetch a pinned CRE CLI release and verify its checksum. We do not use the official install.sh: it
# needs gpg, is not version-pinned, and also probes for Go and Bun.
FROM debian:bookworm-slim AS cre-bin
ARG TARGETARCH
ARG CRE_VERSION
ARG CRE_SHA256_AMD64
ARG CRE_SHA256_ARM64
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) sha="$CRE_SHA256_AMD64" ;; \
      arm64) sha="$CRE_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="cre_linux_${TARGETARCH}_ldd2-35.tar.gz"; \
    curl -fsSL "https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/${asset}" -o "/tmp/${asset}"; \
    echo "${sha}  /tmp/${asset}" | sha256sum -c -; \
    mkdir /tmp/x /out; \
    tar -xzf "/tmp/${asset}" -C /tmp/x; \
    [ "$(find /tmp/x -type f | wc -l)" = 1 ]; mv "$(find /tmp/x -type f)" /out/cre; \
    chmod 0755 /out/cre; \
    /out/cre version

# ---------------------------------------------------------------- bun (binary source)
FROM oven/bun:${BUN_VERSION}-slim AS bun

# ---------------------------------------------------------------- auditor-deps (build stage only)
# The CRE auditor workflow has its own bun lockfile; only its node_modules is carried forward.
FROM bun AS auditor-deps
WORKDIR /w
COPY workflows/auditor/auditor/package.json workflows/auditor/auditor/bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------- bundles (build stage only)
# One ESM file per service with every dependency inlined. bufferutil / utf-8-validate are optional
# native speedups of `ws`; they are left out and ws falls back to its JS implementation.
FROM deps AS bundles
ARG ESBUILD_VERSION
RUN npm install -g esbuild@${ESBUILD_VERSION}
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# The gateway bundles the breaker bot for the web app's "Run breaker bot" button.
COPY apps/breaker-bot apps/breaker-bot
COPY apps/gateway apps/gateway
COPY apps/runner apps/runner
RUN set -eux; \
    for app in gateway runner; do \
      esbuild "apps/$app/src/main.ts" --bundle --platform=node --target=node24 --format=esm \
        --external:bufferutil --external:utf-8-validate \
        --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
        --outfile="/out/$app.mjs" --log-level=warning; \
    done

# ---------------------------------------------------------------- sea (build stage only)
# Inject each bundle into a copy of the node binary. import.meta.url inside an SEA is the executable's
# own path, so the gateway finds its migrations at <exe dir>/../migrations.
FROM node:${NODE_SEA_VERSION}-bookworm-slim AS sea
ARG POSTJECT_VERSION
RUN npm install -g postject@${POSTJECT_VERSION}
COPY --from=bundles /out /bundles
RUN set -eux; mkdir /out; cd /bundles; \
    for app in gateway runner; do \
      printf '{"main":"%s.mjs","mainFormat":"module","output":"%s.blob","disableExperimentalSEAWarning":true}' "$app" "$app" > "$app.sea.json"; \
      node --experimental-sea-config "$app.sea.json"; \
      cp "$(command -v node)" "/out/$app"; \
      postject "/out/$app" NODE_SEA_BLOB "$app.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2; \
      chmod 0755 "/out/$app"; \
    done

# ---------------------------------------------------------------- web
# NEXT_PUBLIC_* are inlined at build time, so they are build args, not runtime env.
FROM deps AS web-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_DATA_MODE=live
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_HEDERA_RPC_URL=https://testnet.hashio.io/api
ARG NEXT_PUBLIC_MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
ARG NEXT_PUBLIC_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_DATA_MODE=$NEXT_PUBLIC_DATA_MODE \
    NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL \
    NEXT_PUBLIC_HEDERA_RPC_URL=$NEXT_PUBLIC_HEDERA_RPC_URL \
    NEXT_PUBLIC_MIRROR_NODE_URL=$NEXT_PUBLIC_MIRROR_NODE_URL \
    NEXT_PUBLIC_SEPOLIA_RPC_URL=$NEXT_PUBLIC_SEPOLIA_RPC_URL \
    NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID \
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @defect/web build

# Final: Next's standalone output (server.js plus only the node_modules it traced), on slim Node.
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------- runtime base for the binaries
# The node binary needs glibc, libstdc++ and libatomic; ca-certificates is for the CRE CLI (Go) and curl-less TLS.
FROM debian:bookworm-slim AS bin-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 libatomic1 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home --home-dir /home/app app
WORKDIR /app

# ---------------------------------------------------------------- runner (private service)
# Binds 0.0.0.0 inside the container because the default (127.0.0.1) is unreachable from the gateway.
# Never publish its port; keep it on the private compose network only.
FROM bin-base AS runner
ENV RUNNER_HOST=0.0.0.0 \
    RUNNER_PORT=8788 \
    RUNNER_DATA_DIR=/data
COPY --from=sea /out/runner /app/bin/runner
RUN mkdir -p /data && chown app:app /data
VOLUME /data
USER app
EXPOSE 8788
ENTRYPOINT ["/app/bin/runner"]

# ---------------------------------------------------------------- gateway (lean: one binary)
# CRE auto-attest is off in this image (CRE_AUTO_ATTEST unset): it has no cre CLI. Use `gateway-cre`
# below if you want the gateway itself to run the CRE auditor after each finalized contest.
FROM bin-base AS gateway
ENV HOME=/home/app \
    GATEWAY_PORT=8787 \
    GATEWAY_DATA_DIR=/data
COPY --from=sea /out/gateway /app/bin/gateway
COPY apps/gateway/migrations /app/migrations
RUN mkdir -p /data /home/app/.cre && chown -R app:app /data /home/app
VOLUME /data
USER app
EXPOSE 8787
ENTRYPOINT ["/app/bin/gateway"]

# ---------------------------------------------------------------- gateway-cre
# Adds the Chainlink CRE CLI (about 200 MB), bun and the auditor workflow, because cre-attest.ts spawns
# `cre workflow simulate auditor --broadcast` after each finalized contest. The job's default workflow
# path is computed from the source tree, so CRE_WORKFLOW_DIR is set explicitly.
# Auth for the CLI is the CRE_API_KEY runtime secret; never copy ~/.cre/cre.yaml into an image.
FROM gateway AS gateway-cre
ENV CRE_WORKFLOW_DIR=/app/workflows/auditor
COPY --from=cre-bin /out/cre /usr/local/bin/cre
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --chown=app:app workflows/auditor /app/workflows/auditor
COPY --from=auditor-deps --chown=app:app /w/node_modules /app/workflows/auditor/auditor/node_modules
