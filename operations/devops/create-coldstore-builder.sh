#!/usr/bin/env bash
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Create the t/4883 cold-store BuildKit builder used by ci.yml's test-container job.
#
# WHY a script (SO p/682#56, condition C1 on the blocking promotion #4634): once the cold-store
# rebuild blocks every PR's ci-gate, the builder's image pull from Docker Hub is on every PR's
# critical path. So:
#   - the image is pinned by DIGEST (a mutable tag could change what the guard runs under us);
#   - --bootstrap pulls the image NOW, inside the retry, instead of lazily during the build where
#     a pull failure would look like a build failure;
#   - after the last attempt it exits 3 with a distinct ::error:: that says INFRA, so a Docker
#     Hub outage or rate limit is never read as the guard's own fail/inconclusive verdict.
#
# Usage: create-coldstore-builder.sh [builder-name]
# Env (test seams): COLDSTORE_BUILDKIT_IMAGE, COLDSTORE_ATTEMPTS (default 3),
#                   COLDSTORE_RETRY_DELAY (seconds, default 15; backoff is attempt x delay).
# Exit: 0 = builder ready; 3 = infrastructure failure (not a guard verdict).
# Tested by tests/CreateColdstoreBuilder.Tests.ps1.

set -u

# moby/buildkit:buildx-stable-1, index digest as of 2026-11-03 (Docker Hub tag API).
DEFAULT_IMAGE='moby/buildkit:buildx-stable-1@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe'

name="${1:-coldstore}"
image="${COLDSTORE_BUILDKIT_IMAGE:-$DEFAULT_IMAGE}"
attempts="${COLDSTORE_ATTEMPTS:-3}"
delay="${COLDSTORE_RETRY_DELAY:-15}"

i=1
while :; do
  # A half-created builder from a failed attempt would make the next create fail on the name.
  docker buildx rm "$name" >/dev/null 2>&1 || true
  if docker buildx create --name "$name" --driver docker-container \
       --driver-opt "image=$image" --bootstrap >/dev/null 2>&1; then
    echo "cold-store builder '$name' ready ($image)"
    exit 0
  fi
  if [ "$i" -ge "$attempts" ]; then
    echo "::error::t/4883 INFRA (not a guard verdict): could not create the cold-store BuildKit builder from $image after $i attempts (Docker Hub pull or rate limit?). Re-run the job; if it persists, check the pinned digest in operations/devops/create-coldstore-builder.sh."
    exit 3
  fi
  wait_s=$((i * delay))
  echo "::warning::t/4883: cold-store builder create attempt $i of $attempts failed; retrying in ${wait_s}s"
  sleep "$wait_s"
  i=$((i + 1))
done
