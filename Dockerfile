# Both bases are digest-pinned (t/270, PI decision 2026-11-10): Dependabot's docker
# ecosystem (`directory: /`) proposes digest bumps, so a rebuild is reproducible and
# updates arrive as reviewable PRs. dockerfile-trivy scans this image report-only.
FROM python:3.15-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS python

FROM mcr.microsoft.com/devcontainers/javascript-node:26-trixie@sha256:045e66010973363cc211c8d86133580eb6106713314797066efe60cba970b9a8

# Pin Python to 3.12 — Debian trixie's own apt repo only ships 3.13. Copy the
# official python:3.12-slim-trixie image's self-contained /usr/local instead
# (same Debian trixie base, so glibc-compatible); it already bundles pip and
# the venv module, so apt's python3-pip/python3-venv are no longer needed.
# A named stage (above) rather than `COPY --from=<image>`, so Dependabot sees the pin.
COPY --from=python /usr/local/ /usr/local/

RUN . /etc/os-release \
  && wget -q "https://packages.microsoft.com/config/debian/${VERSION_ID}/packages-microsoft-prod.deb" \
  && dpkg -i packages-microsoft-prod.deb && rm packages-microsoft-prod.deb \
  && apt-get update && apt-get install -y --no-install-recommends powershell \
  && rm -rf /var/lib/apt/lists/*

# Make tests available
RUN pwsh -NoProfile -c "Install-Module Pester -RequiredVersion 5.7.1 -Force -Scope AllUsers"

RUN apt-get update && apt-get install -y --no-install-recommends \
  pandoc ghostscript \
  && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN npm install -g pnpm@11.20.0
WORKDIR /workspaces/ai-triad-research
# Mount point for the pnpm-store volume
RUN mkdir -p /pnpm/store && chown node:node /pnpm/store

# Do this first with CPU-only torch, so that layer comes first.
# The torch version comes only from scripts/pip-constraints.txt (t/4884); the
# requirements install below uses the same constraints, so a dependency that
# wants a different torch fails the build instead of pulling a CUDA wheel.
COPY scripts/pip-constraints.txt /tmp/pip-constraints.txt
RUN --mount=type=cache,target=/root/.cache/pip \
      pip install --index-url https://download.pytorch.org/whl/cpu -c /tmp/pip-constraints.txt torch

# Rebuild only when requirements.txt changes
COPY scripts/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
      pip install -c /tmp/pip-constraints.txt -r /tmp/requirements.txt


