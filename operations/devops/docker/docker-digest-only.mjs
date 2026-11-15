// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Docker digest-only predicate (t/315, incident t/313). PURE: no imports, no I/O, no globals,
// so dependabot-auto-merge.yml (DevOps) can import it as-is.
//
// Why: fetch-metadata labels a docker tag move such as python 3.12 -> 3.15 `semver-minor`, so
// the auto-merge arm fired on it (#5015) and broke the dev image. Rule (TL, t/313): for the
// docker ecosystem, auto-merge only DIGEST-ONLY updates. Any tag change needs review.
//
// Input is the PR's changed files as the REST `pulls.listFiles` API returns them
// ({filename, patch}). Digest-only means:
//   - every changed file is a Dockerfile (Dockerfile, Dockerfile.*, *.Dockerfile);
//   - every file has a patch (a missing patch means truncated or binary, so fail closed);
//   - removed and added lines pair up one-for-one, in order, and each pair is a
//     `FROM <image>:<tag>@sha256:<digest> [AS <stage>]` line with the same image:tag, the same
//     --platform and the same stage on both sides, where only the digest changes.
// Anything else is not digest-only. Keep this module import-free: its test fails on an import.
//
// Tests: node --test operations/devops/docker/docker-digest-only.test.mjs

const DOCKERFILE_NAME = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.Dockerfile)$/;
const FROM_PINNED = /^FROM\s+((?:--platform=\S+\s+)?)([^\s@]+)@(sha256:[0-9a-f]{64})((?:\s+AS\s+\S+)?)\s*$/i;

/** PURE. Removed and added lines of one unified-diff patch (file headers excluded). */
export function changedLines(patch) {
  const removed = [];
  const added = [];
  for (const line of String(patch).split(/\r?\n/)) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

/**
 * PURE. Is this docker PR a digest-only update?
 * @param {Array<{filename: string, patch?: string}>} files  REST pulls.listFiles entries
 * @returns {{digestOnly: boolean, reason: string}}
 */
export function isDigestOnlyDockerUpdate(files) {
  const no = (reason) => ({ digestOnly: false, reason });
  if (!Array.isArray(files) || files.length === 0) return no('no changed files');
  let pairs = 0;
  for (const f of files) {
    const name = f && typeof f.filename === 'string' ? f.filename : '';
    if (!DOCKERFILE_NAME.test(name)) return no(`'${name || '?'}' is not a Dockerfile`);
    if (typeof f.patch !== 'string' || f.patch === '') return no(`${name}: no patch (truncated or binary); failing closed`);
    const { removed, added } = changedLines(f.patch);
    if (removed.length !== added.length) return no(`${name}: ${removed.length} line(s) removed vs ${added.length} added`);
    for (let i = 0; i < removed.length; i++) {
      const was = FROM_PINNED.exec(removed[i].trim());
      const now = FROM_PINNED.exec(added[i].trim());
      if (!was || !now) return no(`${name}: changed line is not a digest-pinned FROM on both sides: '${(was ? added[i] : removed[i]).trim()}'`);
      const [, wasPlat, wasRef, wasDigest, wasStage] = was;
      const [, nowPlat, nowRef, nowDigest, nowStage] = now;
      if (wasRef !== nowRef) return no(`${name}: image/tag changed ${wasRef} -> ${nowRef}`);
      if (wasPlat.trim() !== nowPlat.trim()) return no(`${name}: --platform changed`);
      if (wasStage.trim().toLowerCase() !== nowStage.trim().toLowerCase()) return no(`${name}: stage name changed`);
      if (wasDigest === nowDigest) return no(`${name}: FROM line changed but the digest did not`);
      pairs++;
    }
  }
  if (pairs === 0) return no('no FROM digest changed');
  return { digestOnly: true, reason: `${pairs} FROM line(s) changed digest only, same image:tag` };
}
