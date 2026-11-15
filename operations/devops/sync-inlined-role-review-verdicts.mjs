// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/200: keeps the INLINED copy of role-review-verdicts.mjs inside t1-approval-guard-predicate.mjs
 * byte-identical to the shared module.
 *
 * WHY THE COPY EXISTS: a `pull_request_review` run executes the PR BRANCH's
 * t1-approval-guard.yml. A branch cut before #4804 carries the old YAML, which copies ONLY
 * t1-approval-guard-predicate.mjs from main's tip into a temp dir and imports it. Once the
 * predicate imported ./role-review-verdicts.mjs, that import crashed with ERR_MODULE_NOT_FOUND
 * and no verdict was posted, so every such T1 PR was stuck. The predicate is therefore
 * self-contained: it carries the shared module's code verbatim between the markers below.
 * role-review-verdicts.mjs stays the one source of truth (t0-enqueue-sweep.mjs and the tests use
 * it); t1-approval-guard-predicate.test.mjs fails if the two copies differ.
 *
 * THE REGION: everything in role-review-verdicts.mjs from its first top-level line
 * `function effectiveTimeOf(` to the end of the file (the code; its long doc header is not
 * copied), placed between BEGIN_MARKER and END_MARKER in the predicate. Line endings are
 * normalized to LF before comparing, so a Windows CRLF checkout compares the same as CI.
 *
 * Usage (from the repo root):
 *   node operations/devops/sync-inlined-role-review-verdicts.mjs          # rewrite the region
 *   node operations/devops/sync-inlined-role-review-verdicts.mjs --check  # exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN_MARKER = '// BEGIN INLINED role-review-verdicts.mjs (t/200) -- generated, do not edit by hand';
export const END_MARKER = '// END INLINED role-review-verdicts.mjs (t/200)';
const REGION_START = 'function effectiveTimeOf(';

function lf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function actionableError({ goal, problem, location, nextSteps }) {
  const err = new Error(`${problem}\n  Goal: ${goal}\n  Location: ${location}\n  Next steps: ${nextSteps}`);
  Object.assign(err, { goal, problem, location, nextSteps });
  return err;
}

/** PURE. The code region of role-review-verdicts.mjs that the predicate must carry verbatim. */
export function inlinedRegionFrom(sharedText) {
  const text = lf(sharedText);
  const nl = text.indexOf(`\n${REGION_START}`);
  if (nl < 0) {
    throw actionableError({
      goal: 'Extract the code region of role-review-verdicts.mjs to inline into the T1 predicate.',
      problem: `role-review-verdicts.mjs has no top-level line starting "${REGION_START}".`,
      location: 'operations/devops/sync-inlined-role-review-verdicts.mjs (inlinedRegionFrom)',
      nextSteps: 'If the first function was renamed, update REGION_START here to the first line of code after the doc header.',
    });
  }
  return text.slice(nl + 1).replace(/\n*$/, '\n');
}

/** PURE. The region currently between the markers in the predicate, or null if the markers are missing. */
export function currentRegionOf(predicateText) {
  const text = lf(predicateText);
  const begin = text.indexOf(`${BEGIN_MARKER}\n`);
  const end = text.indexOf(`\n${END_MARKER}`);
  if (begin < 0 || end < 0 || end < begin) return null;
  return text.slice(begin + BEGIN_MARKER.length + 1, end + 1);
}

/** PURE. The predicate text with its marker region replaced by `region`. */
export function spliceRegion(predicateText, region) {
  const text = lf(predicateText);
  const current = currentRegionOf(text);
  if (current === null) {
    throw actionableError({
      goal: 'Rewrite the inlined role-review-verdicts region in t1-approval-guard-predicate.mjs.',
      problem: 'The BEGIN/END INLINED markers are missing or out of order in the predicate.',
      location: 'operations/devops/t1-approval-guard-predicate.mjs',
      nextSteps: `Restore the two marker lines exactly:\n${BEGIN_MARKER}\n${END_MARKER}`,
    });
  }
  const begin = text.indexOf(`${BEGIN_MARKER}\n`) + BEGIN_MARKER.length + 1;
  return text.slice(0, begin) + region + text.slice(begin + current.length);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const sharedPath = join(here, 'role-review-verdicts.mjs');
  const predicatePath = join(here, 't1-approval-guard-predicate.mjs');
  const region = inlinedRegionFrom(readFileSync(sharedPath, 'utf8'));
  const predicateText = readFileSync(predicatePath, 'utf8');
  if (process.argv.includes('--check')) {
    if (currentRegionOf(predicateText) !== region) {
      console.error('t1-approval-guard-predicate.mjs: the inlined role-review-verdicts region has drifted from role-review-verdicts.mjs. Run: node operations/devops/sync-inlined-role-review-verdicts.mjs');
      process.exit(1);
    }
    console.log('t1-approval-guard-predicate.mjs: inlined role-review-verdicts region is in sync.');
  } else {
    writeFileSync(predicatePath, spliceRegion(predicateText, region));
    console.log('t1-approval-guard-predicate.mjs: inlined role-review-verdicts region rewritten.');
  }
}
