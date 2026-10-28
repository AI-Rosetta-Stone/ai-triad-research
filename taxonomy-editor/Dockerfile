# syntax=docker/dockerfile:1.7

# AI Triad Taxonomy Editor — Container Image
# Multi-stage build: compile TypeScript, then copy artifacts to lean runtime.
#
# Requires the base image: ghcr.io/ai-rosetta-stone/ai-triad-base:<date-tag>
# (see deploy/azure/Dockerfile.base)

# ── Stage 1: Build ──
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS builder

WORKDIR /build

# Native-module build deps for node-gyp (node-pty etc.)
# Builder stage is discarded — no impact on runtime image size.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++

RUN npm install -g pnpm@11.20.0

# Copy dependency manifests first (Docker layer caching)
# pnpm-workspace.yaml + root pnpm-lock.yaml establish the workspace root at /build so
# allowBuilds applies; root package.json carries @types/node (needed by build:container tsc).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY taxonomy-editor/package.json taxonomy-editor/pnpm-lock.yaml ./taxonomy-editor/
COPY lib/ ./lib/

# Install Node deps (including devDependencies for build)
# Use isolated linker (not hoisted) so the .pnpm/ virtual store is created — required for
# `pnpm licenses list` (called by `npm run licenses` in build:container). The prod-deps stage
# still uses hoisted linker (from .npmrc) for native-module compatibility.
WORKDIR /build/taxonomy-editor
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --config.node-linker=isolated

# Install shared-lib deps too (t/2035): lib/ is a self-contained package with its
# own package.json, and the sanitizer core's renderer-parity decoders must resolve
# from lib/node_modules during build:server (tsc). Mirrors the test-electron CI job
# (ci.yml "Install shared lib dependencies"). Without this, build:container's tsc
# fails TS2307 on the lib/ core's decoder imports.
# Use isolated linker to match the taxonomy-editor install above — mixed linkers across
# workspace packages corrupt the virtual store, breaking `pnpm licenses list`.
WORKDIR /build/lib
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --config.node-linker=isolated

# Copy source and build
WORKDIR /build
COPY taxonomy-editor/src/ ./taxonomy-editor/src/
COPY taxonomy-editor/tsconfig.json ./taxonomy-editor/
COPY taxonomy-editor/tsconfig.main.json ./taxonomy-editor/
COPY taxonomy-editor/tsconfig.server.json ./taxonomy-editor/
COPY taxonomy-editor/vite.config.ts ./taxonomy-editor/
COPY taxonomy-editor/scripts/ ./taxonomy-editor/scripts/
COPY ai-models.json ./
COPY ai-usages.json ./
COPY .aitriad.json ./
COPY CHANGELOG.md ./
COPY taxonomy/schemas/ ./taxonomy/schemas/

WORKDIR /build/taxonomy-editor

# Expose commit SHA to Vite at build time so it's baked into the renderer bundle.
# Empty default → fallback chain in vite.config.ts handles missing arg gracefully.
ARG BUILD_SHA
ENV BUILD_SHA=$BUILD_SHA

# Cache mount required: pnpm store not in image layer — `pnpm licenses list` reads
# package index files from the store.
# pnpm shim: in workspace mode, `pnpm licenses list --prod` (called by generate-license-file)
# enumerates ALL workspace packages including workflow-app's @google/genai, @modelcontextprotocol/sdk
# etc. that are NOT installed in this stage → ERR_PNPM_MISSING_PACKAGE_INDEX_FILE.
# Deleting pnpm-workspace.yaml triggers a different failure: workspace vs standalone lockfiles
# resolve some packages to different versions (e.g. @azure-rest/core-client 2.8.0 vs 2.6.0)
# so generate-license-file looks for a version that doesn't exist in the virtual store.
# Fix: intercept the `pnpm licenses list` call via a PATH shim that appends
# --filter taxonomy-editor, scoping the listing to only installed packages.
# The workspace virtual store paths remain valid (no workspace marker deleted).
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    REAL_PNPM="$(which pnpm)" && \
    printf '%s\n' '#!/bin/sh' \
        "REAL_PNPM=${REAL_PNPM}" \
        'if [ "$1" = "licenses" ]; then' \
        '  exec "$REAL_PNPM" "$@" --filter taxonomy-editor' \
        'else' \
        '  exec "$REAL_PNPM" "$@"' \
        'fi' > /tmp/pnpm && \
    chmod +x /tmp/pnpm && \
    PATH="/tmp:$PATH" npm run build:container

# ── Stage 1b: ONNX model download ──
# Bakes all-MiniLM-L6-v2 (fp32, equivalence-anchored at t/1651) into the image
# so onnxEmbedding.ts runs fully offline. Without this, each cold-start downloads
# from HuggingFace at runtime, hitting the 50s route timeout (t/2784).
# fp32 is required — quantized output diverges from the stored embeddings.json corpus.
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS onnx-model
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
RUN mkdir -p /onnx/all-MiniLM-L6-v2 \
 && curl -fsSL "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx" \
         -o /onnx/all-MiniLM-L6-v2/model.onnx \
 && curl -fsSL "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json" \
         -o /onnx/all-MiniLM-L6-v2/tokenizer.json \
 && curl -fsSL "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json" \
         -o /onnx/all-MiniLM-L6-v2/tokenizer_config.json

# ── Stage 2: Production dependencies (with build tools for native modules) ──
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS prod-deps

# node-pty requires make/g++/python3 for compilation when prebuilds
# are unavailable. The runtime base image is intentionally slim (no
# build tools), so compile here and copy the result.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++

RUN npm install -g pnpm@11.20.0

WORKDIR /deps
COPY taxonomy-editor/package.json taxonomy-editor/pnpm-lock.yaml ./
# pnpm-workspace.yaml carries the allowBuilds config that permits lifecycle scripts
# for node-pty, onnxruntime-node, sharp, protobufjs. This stage's node_modules is what
# ships (the runtime image COPYs --from=prod-deps, NOT from builder), so these native
# modules MUST actually compile here — do NOT add --ignore-scripts. Verified in CI:
# node-pty builds via node-gyp and the --prod install exits 0. electron (a devDep) is
# absent, so the electron-rebuild postinstall no-ops (|| exit 0) without failing.
COPY pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --prod --frozen-lockfile

# ── Stage 3: Runtime ──
# CI smoke = liveness-only (any HTTP status passes; t/2067). Data-readiness proven at staging
# (deploy-staging.yml Test-TaxEditorHealth /healthz). :2026-07-30 was exonerated in t/2047 —
# root cause was t/2061 (isDataAvailable path mismatch, app-side). Bumped to :2026-08-15 for
# Debian 13 Trixie upgrade + .trivyignore cleanup (t/2681).
# Bumped to :2026-08-31 for the cache-bust security rebuild (t/3137) — the base now
# genuinely re-runs apt/npm upgrades: openssl 3.5.7-1~deb13u2 (CVE-2026-14456) and
# npm's bundled tar 7.5.21 (CVE-2026-73566), both proven by the base build tripwires.
# Bumped to :2026-09-21 for the code-scanning CVE sweep (t/3513) — fresh cache-busted
# apt-get upgrade clears the fixable OS-package CVEs; node held at 22.23.2 per the
# Dockerfile.base guardrail (t/2047 P1). Residual no-fix CVEs ride .trivyignore + the
# weekly-rebuild auto-retirement.
# Bumped to :2026-09-29 (t/3746) — poppler-utils removed from base (eliminates
# libX11/libXrender transitive-dep CVE class); glibc CVEs cleared by apt-get upgrade.
# Bumped to :2026-10-02 (PR #2676) — npm-bundled undici 6.28.1 (CVE-2026-85024), ip-address
# 10.5.1 (CVE-2026-101910/101913), brace-expansion 5.0.12; proven by the base build tripwire.
# Gate base bumps on staging /healthz, not CI green.
# Bumped to :2026-10-19 — the container.yml Trivy blocking gate caught libexpat1
# CVE-2026-77214 (fixable high) on :2026-10-06; this tag is base-image.yml's normal weekly
# rebuild (apt-get upgrade), dispatched a cycle early to unblock a pending container build.
# Bumped to :2026-10-28 (t/1990) — Node 22 -> 26 (Active LTS), landed atomically with
# ci.yml's node-version bump and userland undici 6->8 (the co-landing PR; Node 26 bundles
# undici 8.x, which trips the undici major-version invariant if the runtime moves alone).
# onnxruntime-node and node-pty verified to build and load under Node 26 with real build
# output before this landed (t/1990#10).
FROM ghcr.io/ai-rosetta-stone/ai-triad-base:2026-10-28@sha256:aea2c6351135e37af25f98d96ba4ed7caf4646339b850979eac919fe63bbadc9 AS runtime

LABEL org.opencontainers.image.source="https://github.com/AI-Rosetta-Stone/ai-triad-research"
LABEL org.opencontainers.image.description="AI Triad Taxonomy Editor"
LABEL org.opencontainers.image.licenses="MIT"

# Build commit SHA baked into the RUNTIME image env (t/3278 drift-prevention). container.yml passes
# --build-arg BUILD_SHA=<sha>; default 'unknown' keeps local/plain builds working. Makes "which
# commit is running in prod?" answerable from the running image env instead of digest forensics.
# ARG is re-declared here because ARGs do not cross stages (the builder stage's BUILD_SHA is for Vite).
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

# Cache dir created at runtime by the app (GitHubAPIBackend).
# Bare/local-run fallback ONLY — every real deployment (main.bicep's baseEnv, both prod and
# staging) sets both vars explicitly and always wins over these image defaults. Kept in sync
# with each other here (t/2047: a mismatch makes toRepoPath()'s startsWith(cacheDir) check
# fail, so isDataAvailable() is always false -> /healthz 503 -> crash-loop) ONLY for the case
# of a plain `docker run` with no env vars supplied at all. Do NOT read this as the real
# prod/staging behavior — see main.bicep's baseEnv/stagingEnvOverrides and t/4298/t/4299/t/4300
# for why the two are deliberately INDEPENDENT there (PR #1078 decoupled them; this Dockerfile
# default predates that and was never updated to match, since it's unreachable once Bicep sets
# both explicitly).
ENV AI_TRIAD_DATA_ROOT=/tmp/taxonomy-cache
ENV TAXONOMY_CACHE_DIR=/tmp/taxonomy-cache
ENV PORT=7862
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
# Baked ONNX model dir — makes onnxEmbedding.ts run fully offline (t/2784, t/1641).
ENV AI_TRIAD_ONNX_MODEL_DIR=/app/onnx-models/all-MiniLM-L6-v2
# PYTHONUTF8=1: PEP 540 UTF-8 Mode — forces UTF-8 for stdio AND open() on all platforms.
# Prevents UnicodeEncodeError/DecodeError on non-ASCII from pty-broker.py (t/2046).
ENV PYTHONUTF8=1

WORKDIR /app

# ── Layers ordered by change frequency (least → most) ──

# 1. Node production dependencies (pre-compiled in prod-deps stage)
COPY --chown=aitriad:aitriad taxonomy-editor/package.json taxonomy-editor/pnpm-lock.yaml ./
COPY --from=prod-deps --chown=aitriad:aitriad /deps/node_modules ./node_modules/

# 2. Stable config and scripts (change occasionally)
COPY --chown=aitriad:aitriad ai-models.json ./
COPY --chown=aitriad:aitriad ai-usages.json ./
COPY --chown=aitriad:aitriad .aitriad.json ./
COPY --chown=aitriad:aitriad taxonomy/schemas/ ./taxonomy/schemas/
COPY --chown=aitriad:aitriad scripts/ ./scripts/
# Op-ed prompt templates (t/2609 relocated them out of scripts/AITriad/Prompts).
# The op-ed create route resolves promptsDir = getProjectRoot()/lib/oped/prompts
# (= /app/lib/oped/prompts here); tsc emits no .prompt assets, so copy the source.
COPY --chown=aitriad:aitriad lib/oped/prompts/ ./lib/oped/prompts/
# Soul-doc JSON at the repo-root path, for op-ed voice generation (t/2689), which locates
# soul-docs from getProjectRoot() (= /app/lib/debate/soul-docs/). The compiled loader reads
# its own copy under dist/server (layer 3 below, t/4245).
COPY --chown=aitriad:aitriad lib/debate/soul-docs/ ./lib/debate/soul-docs/

# 2b. ONNX model files (baked offline; change only when model contract changes — t/2784)
COPY --from=onnx-model --chown=aitriad:aitriad /onnx/all-MiniLM-L6-v2/ ./onnx-models/all-MiniLM-L6-v2/

# 3. Built artifacts (change on every code edit — LAST for fastest rebuilds)
# tsc outputs to dist/server/{taxonomy-editor/src/server/,lib/} due to rootDir=../
# Keep the full structure so compiled require() paths work, then symlink
# renderer and package.json where __dirname-relative lookups expect them.
COPY --chown=aitriad:aitriad --from=builder /build/taxonomy-editor/dist/server/ ./dist/server/
COPY --chown=aitriad:aitriad --from=builder /build/taxonomy-editor/dist/renderer/ ./dist/renderer/
RUN ln -s /app/dist/renderer /app/dist/server/taxonomy-editor/src/renderer \
 && ln -s /app/package.json /app/dist/server/taxonomy-editor/src/package.json
# Soul-doc JSON for the compiled loader (t/4245). soulDocLoader.ts resolves SOUL_DOCS_DIR from its
# own compiled location (= /app/dist/server/lib/debate/soul-docs/), and tsc emits only the JSON it
# imports, so the tag souls were missing there and every tagged run failed on the hosted profile.
COPY --chown=aitriad:aitriad lib/debate/soul-docs/ ./dist/server/lib/debate/soul-docs/
# Build-time guard (t/4245): the image build fails if the compiled loader can't load a base soul
# and a tag soul, so this path can't regress silently again.
RUN node --input-type=module -e "const m = await import('/app/dist/server/lib/debate/soulDocLoader.js'); m.getSoulDocument('skeptic'); m.getSoulDocument('skeptic', 'critical'); console.log('soul-doc load check: OK (base + tag)');"

# 4. Third-party license notices (generated during build)
COPY --chown=aitriad:aitriad --from=builder /build/taxonomy-editor/THIRD-PARTY-NOTICES.txt ./taxonomy-editor/THIRD-PARTY-NOTICES.txt

# 5. PTY broker script (Python, not compiled by tsc — copy to where config.ts expects it)
COPY --chown=aitriad:aitriad taxonomy-editor/src/main/pty-broker.py ./src/main/pty-broker.py

# 5b. Grounding reconciler (Python, G8 enable prereq — t/3213). The G8a inline write-hook
#     (groundingReconcileHook.ts) and the G8b full sweep (groundingSweepScheduler.ts) shell out
#     to this at RECONCILE_SCRIPT (config.ts:402 = /app/research/comp-linguist/scripts/
#     reconcile_grounding.py; PROJECT_ROOT=/app). Without it every sweep would ENOENT/
#     ModuleNotFoundError — dead-on-arrival as shipped (t/3172#4). The script is stdlib + numpy;
#     numpy is NOT in the base image, so install it via apt (python3-numpy) — debian-native, no
#     pip/PEP-668/venv dance, into the same system python3 the server's execFile('python3', …)
#     uses. DevOps's container smoke asserts `python3 <script> --selftest` exits 0 (t/3213 AC).
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3-numpy
COPY --chown=aitriad:aitriad research/comp-linguist/scripts/reconcile_grounding.py ./research/comp-linguist/scripts/reconcile_grounding.py

# 6. Fallback taxonomy snapshot — baked last-known-good data for GitHub outages.
#    CI fetches from ai-triad-data HEAD; changes on every build — LAST layer.
#    Contains snapshot-meta.json with generation timestamp for stale-data banner.
#    For local builds: mkdir -p taxonomy-snapshot && echo '{}' > taxonomy-snapshot/snapshot-meta.json
COPY --chown=aitriad:aitriad taxonomy-snapshot/ ./fallback-data/

# 7. PowerShell Core — required for the web console ("Console (pwsh + AITriad)") (t/2824)
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL "https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb" \
      -o /tmp/ms-prod.deb \
    && dpkg -i /tmp/ms-prod.deb \
    && rm /tmp/ms-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends powershell

# 7b. Security bump: libbrotli1 (t/4504, blocking the container Trivy gate). CVE-2026-111497,
# HIGH, out-of-bounds write in the Brotli decoder, fixed in 1.1.0-2+deb13u1 -- the base image
# (ai-triad-base:2026-10-19) baked the vulnerable 1.1.0-2+b7. --only-upgrade pulls just this
# package from the already-configured apt sources rather than waiting on a full base rebuild.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install --only-upgrade -y libbrotli1

# 8. Strip global npm from the runtime image (t/3135). npm is NOT reachable at
# runtime — CMD is a direct `node`; npm/pnpm are used only in the discarded
# builder/prod-deps stages; the web console spawns pwsh (not npm); there is no
# start-time npm script. Removing it deletes the entire npm-bundled-dep CVE class
# (e.g. tar CVE-2026-73566 under .../node_modules/npm/node_modules/tar) from the
# deployed image in one shot. The `command -v npm` guard fails the build loudly if
# a future base layout leaves npm behind, so the strip can't silently regress.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
    && if command -v npm >/dev/null 2>&1; then echo "[t/3135] ERROR: npm still on PATH after strip" && exit 1; fi \
    && echo "[t/3135] npm/npx stripped from runtime image"

USER aitriad

EXPOSE 7862

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s \
  CMD curl -f http://localhost:7862/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/taxonomy-editor/src/server/server.js"]
