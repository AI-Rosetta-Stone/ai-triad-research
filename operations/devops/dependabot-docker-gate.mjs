// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/315 (t/313 P4): Dependabot auto-merge for the `docker` ecosystem only on digest-only diffs.
 *
 * WHY: #5015 moved the dev image's FROM `python:3.12-slim-trixie` -> `3.15-slim-trixie`.
 * dependabot-auto-merge.yml treated it as semver-minor and armed it, it merged at 03:03Z, and the
 * dev image broke (`markitdown` needs Python <3.15). A tag change is a real upgrade; a digest-only
 * change (same image:tag, new `@sha256:`) is a rebuild of the same version.
 *
 * The decision is Docker's pure predicate (operations/devops/docker/docker-digest-only.mjs),
 * imported, not copied. This module only adds the caller's fail-closed rules around it, so the
 * workflow's github-script stays a thin fetch + comment.
 */
import { isDigestOnlyDockerUpdate } from './docker/docker-digest-only.mjs';

export const DOCKER_GATE_MARKER = '<!-- t315-docker-not-digest-only:';

/**
 * PURE. May a docker-ecosystem Dependabot PR be armed for auto-merge?
 * @param {{files: Array<{filename:string, patch?:string}>|null, truncated?: boolean}} input
 *   `files` = every `pulls.listFiles` entry (paginated); null when the list could not be read.
 *   `truncated` = the list may be incomplete (GitHub caps it at 3000 files).
 * @returns {{arm: boolean, reason: string}}
 */
export function dockerAutoMergeVerdict({ files, truncated = false }) {
  if (files == null) return { arm: false, reason: 'could not read the changed-file list; failing closed' };
  if (truncated) return { arm: false, reason: 'changed-file list may be truncated; failing closed' };
  const v = isDigestOnlyDockerUpdate(files);
  return v.digestOnly
    ? { arm: true, reason: v.reason }
    : { arm: false, reason: `not a digest-only update: ${v.reason}` };
}

/** PURE. The one-per-head comment body for a docker PR left unarmed. */
export function dockerGateComment({ headSha, reason }) {
  return [
    `**Dependabot auto-merge not armed (t/315).** This docker update is ${reason}.`,
    '',
    'Docker updates auto-merge only when every changed `FROM` keeps the same `image:tag` and only the `@sha256:` digest changes. A tag change is a real version upgrade (#5015, python 3.12 -> 3.15, broke the dev image), so it needs a human or role review before it merges.',
    `${DOCKER_GATE_MARKER}${headSha} -->`,
  ].join('\n');
}
