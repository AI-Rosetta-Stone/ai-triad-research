// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Prevention (t/4866): every container.yml build since #4498 (t/4840) failed because it
// pinned actions/cache/restore and actions/cache/save to cf430e03... -- the SHA of a commit
// on actions/upload-artifact, not actions/cache. workflow-lint.py's existing check only
// confirms a `uses:` ref LOOKS like `owner/repo@<40-hex-sha>`; it never confirms that SHA
// actually exists on that repo. This script does, via the GitHub API.
//
// Pure core (parseActionPins) is unit-tested; the GitHub API calls are the impure shim --
// same split as check-merge-head-drift.mjs / enqueue-pr.mjs.
//
//   node operations/devops/check-action-pin-resolution.mjs [--dir=.github/workflows]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Matches both the plain-key and compact list-item `uses:` forms (same two shapes
// workflow-lint.py's USES_RE handles), but only SHA-pinned refs -- a non-SHA ref (tag,
// branch) is already caught by workflow-lint.py's unpinned-ref check, not this script's job.
const USES_SHA_RE = /^\s*(?:-\s+)?uses:\s+([^@\s]+)@([0-9a-f]{40})\b/;

/**
 * @param {Map<string, string>} filesByPath - workflow file path -> its content
 * @returns {{ownerRepo: string, sha: string, file: string, line: number, ref: string}[]}
 *   One entry per unique (ownerRepo, sha) pair, with the FIRST file/line it appears at
 *   (for reporting) -- callers resolve each pair's SHA once via the GitHub API, not once
 *   per occurrence, since the same action pin repeats across many workflow files.
 */
export function parseActionPins(filesByPath) {
  const seen = new Map(); // `${ownerRepo}@${sha}` -> entry
  for (const [file, content] of filesByPath) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(USES_SHA_RE);
      if (!m) continue;
      const [, ref, sha] = m;
      // A ref can carry a subpath (actions/cache/restore@<sha>) -- the API resolves
      // against the REPO, so only the first two segments matter.
      const ownerRepo = ref.split('/').slice(0, 2).join('/');
      const key = `${ownerRepo}@${sha}`;
      if (!seen.has(key)) {
        seen.set(key, { ownerRepo, sha, file, line: i + 1, ref });
      }
    }
  }
  return [...seen.values()];
}

/** @returns {Map<string, string>} */
export function readWorkflowFiles(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    map.set(join(dir, name), readFileSync(join(dir, name), 'utf8'));
  }
  return map;
}

// t/4867 acceptance criterion: a transient API error (rate limit, timeout, 5xx, or `gh`
// itself unavailable) must NOT read the same as a confirmed-bad pin -- only a definitive
// "this SHA doesn't exist" response (404 repo-not-found, or 422 "No commit found for SHA"
// on a real repo) is real drift. Anything else is INDETERMINATE: fail open, flag it as an
// advisory, never block on it.
export const DEFINITIVE_NOT_FOUND_RE = /HTTP 404|HTTP 422|No commit found for SHA/;

/**
 * Impure shim: confirms a SHA exists on the given owner/repo via the GitHub API.
 * @returns {Promise<{status: 'resolved'|'unresolved'|'indeterminate', detail?: string}>}
 */
export async function resolvesOnGitHub(ownerRepo, sha) {
  try {
    execFileSync('gh', ['api', `repos/${ownerRepo}/commits/${sha}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { status: 'resolved' };
  } catch (err) {
    const stderr = String(err.stderr ?? err.message ?? '');
    if (DEFINITIVE_NOT_FOUND_RE.test(stderr)) {
      return { status: 'unresolved', detail: stderr.trim() };
    }
    return { status: 'indeterminate', detail: stderr.trim() || '(no detail captured)' };
  }
}

export async function scan(dir) {
  const files = readWorkflowFiles(dir);
  const pins = parseActionPins(files);
  const unresolved = [];
  const indeterminate = [];
  for (const pin of pins) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: gh api is rate-
    // limited per-token, and this runs against a few dozen unique pins, not hundreds.
    const { status, detail } = await resolvesOnGitHub(pin.ownerRepo, pin.sha);
    if (status === 'unresolved') unresolved.push({ ...pin, detail });
    else if (status === 'indeterminate') indeterminate.push({ ...pin, detail });
  }
  return { checked: pins.length, filesScanned: files.size, unresolved, indeterminate };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const dirArg = process.argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.split('=')[1] : '.github/workflows';
  scan(dir).then(
    ({ checked, filesScanned, unresolved, indeterminate }) => {
      console.log(`check-action-pin-resolution: checked ${checked} unique action pin(s) across ${filesScanned} workflow file(s).`);
      for (const u of unresolved) {
        console.log(`::error::${u.file}:${u.line}: '${u.ref}@${u.sha}' does not resolve -- SHA ${u.sha} does not exist on ${u.ownerRepo} (wrong repo, or the SHA was mistyped/copy-pasted from a different action). See t/4866. (${u.detail})`);
      }
      for (const u of indeterminate) {
        console.log(`::warning::${u.file}:${u.line}: '${u.ref}@${u.sha}' could not be checked (API error, not a confirmed bad pin) -- retry this run before treating it as drift. (${u.detail})`);
      }
      if (unresolved.length) {
        console.log(`check-action-pin-resolution: ${unresolved.length} unresolved pin(s), ${indeterminate.length} indeterminate (not counted as failures).`);
        process.exit(1);
      }
      if (indeterminate.length) {
        console.log(`check-action-pin-resolution: ${indeterminate.length} pin(s) could not be checked (API error) -- failing OPEN, not treating as drift. Retry advisory: re-run this check.`);
        return;
      }
      console.log('check-action-pin-resolution: clean -- every SHA-pinned action resolves on its declared repo.');
    },
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
