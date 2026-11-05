#!/usr/bin/env bash
# Codespaces post-create, devcontainer lifecycle hook - delegates to the root bootstrap so there's one definition of workspace setup

set -euo pipefail

exec "$(dirname "$0")/../scripts/dev-bootstrap.sh"
