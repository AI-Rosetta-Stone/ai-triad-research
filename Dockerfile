FROM mcr.microsoft.com/devcontainers/javascript-node:22

# Pin Python to 3.12 — Debian trixie's own apt repo only ships 3.13. Copy the
# official python:3.12-slim-trixie image's self-contained /usr/local instead
# (same Debian trixie base, so glibc-compatible); it already bundles pip and
# the venv module, so apt's python3-pip/python3-venv are no longer needed.
COPY --from=python:3.12-slim-trixie /usr/local/ /usr/local/

RUN . /etc/os-release \
  && wget -q "https://packages.microsoft.com/config/debian/${VERSION_ID}/packages-microsoft-prod.deb" \
  && dpkg -i packages-microsoft-prod.deb && rm packages-microsoft-prod.deb \
  && apt-get update && apt-get install -y --no-install-recommends powershell \
  && rm -rf /var/lib/apt/lists/*

# Make tests available
RUN pwsh -NoProfile -c "Install-Module Pester -Force -Scope AllUsers"

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

# Do this first with CPU-only torch, so that layer comes first
# Note that this doesn't read the version from requirements.txt, so a change
# to the torch version needs to be carried over here
RUN --mount=type=cache,target=/root/.cache/pip \
      pip install --index-url https://download.pytorch.org/whl/cpu torch==2.15.0

# Rebuild only when requirements.txt changes
COPY scripts/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
      pip install -r /tmp/requirements.txt


