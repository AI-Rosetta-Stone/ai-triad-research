// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/314 / t/318 (t/313 observability): every job that carries the canonical rate-limit snapshot
 * step (operations/devops/rate-limit-snapshot-step.yml), and the text helpers that find a job's
 * block in a workflow file. One list, read by rate-limit-snapshot-step.test.mjs (drift check)
 * and by `node operations/devops/rate-limit-snapshot-targets.mjs --apply` (insertion).
 *
 * Each entry is [workflow file under .github/workflows, job id]. The step must be the LAST step of
 * that job, so it records end-of-job usage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_TARGETS = [
  // t/314: the five per-PR guards.
  ['tier-check.yml', 'tier-check'],
  ['t1-approval-guard.yml', 'evaluate'],
  ['joint-gv-guard.yml', 'joint-gv-guard'],
  ['consult-hold-guard.yml', 'consult-hold-guard'],
  ['foreign-commit-check.yml', 'check'],
  // t/318: the next suspects for pool B's heavy REST consumer (t/313#26).
  ['ci.yml', 'record-base-ref'],
  ['ci.yml', 'contrast-check'],
  ['ci.yml', 'action-pin-resolution'],
  ['ci.yml', 'complexity-tickets'],
  ['ci.yml', 'dockerfile-trivy'],
  ['ci.yml', 'ci-gate'],
  ['ci.yml', 'consult-hold-guard'],
  ['ci.yml', 'joint-gv-guard'],
  ['ci.yml', 't1-approval-guard'],
  ['pr-triage.yml', 'triage'],
  ['pr-triage.yml', 'stuck-pr-alert'],
  ['enqueue-sweep.yml', 'sweep'],
  ['ci-infra-rerun.yml', 'rerun-infra-failures'],
  ['ci-infra-rerun.yml', 'alert-infra-failures'],
];

const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/;

/** PURE. [start, end) line range of job `id` under `jobs:`, trailing blank lines excluded. */
export function jobRange(lines, id) {
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return null;
  let start = -1;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = JOB_KEY.exec(lines[i]);
    if (m && m[1] === id) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (JOB_KEY.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break; }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [start, end];
}

/** PURE. The job's block text (LF), or null. */
export function jobBlock(text, id) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const r = jobRange(lines, id);
  return r ? lines.slice(r[0], r[1]).join('\n') : null;
}

/** PURE. Index of the job's `steps:` line within [start, end), or -1. */
export function stepsLineIndex(lines, [start, end]) {
  for (let i = start + 1; i < end; i++) if (/^ {4}steps:\s*$/.test(lines[i])) return i;
  return -1;
}

/** PURE (t/563). The job's FIRST step text (from its first `      - ` to just before its second), or null. */
export function firstStepBlock(text, id) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const r = jobRange(lines, id);
  if (!r) return null;
  const s = stepsLineIndex(lines, r);
  if (s < 0) return null;
  // The canonical start step begins with its comment lines, so the block starts right after `steps:`.
  let second = -1;
  let seenFirst = false;
  for (let i = s + 1; i < r[1]; i++) {
    if (/^ {6}- /.test(lines[i])) {
      if (seenFirst) { second = i; break; }
      seenFirst = true;
    }
  }
  let end = second < 0 ? r[1] : second;
  // A blank line and the NEXT step's own leading comments belong to the next step.
  while (end > s + 1 && (lines[end - 1].trim() === '' || /^ {6}#/.test(lines[end - 1]))) end--;
  return lines.slice(s + 1, end).join('\n');
}

function apply(root) {
  const canonical = readFileSync(path.join(root, 'operations/devops/rate-limit-snapshot-step.yml'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const startStep = readFileSync(path.join(root, 'operations/devops/rate-limit-snapshot-start-step.yml'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  for (const [file, id] of SNAPSHOT_TARGETS) {
    const p = path.join(root, '.github/workflows', file);
    const lines = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const r = jobRange(lines, id);
    if (!r) { console.log(`MISSING job ${id} in ${file}`); process.exitCode = 1; continue; }
    let changed = false;
    if (!lines.slice(r[0], r[1]).join('\n').endsWith(canonical)) {
      lines.splice(r[1], 0, '', ...canonical.split('\n'));
      changed = true;
    }
    // t/563: the start snapshot as the job's FIRST step, right after `steps:`.
    if (!lines.slice(r[0], r[1] + canonical.split('\n').length + 1).join('\n').includes(startStep)) {
      const s = stepsLineIndex(lines, r);
      if (s < 0) { console.log(`NO steps: in ${file}:${id}`); process.exitCode = 1; continue; }
      lines.splice(s + 1, 0, ...startStep.split('\n'), '');
      changed = true;
    }
    if (changed) writeFileSync(p, lines.join('\n'));
    console.log(`${changed ? 'updated' : 'ok (present)'} ${file}:${id}`);
  }
}

if (process.argv[2] === '--apply') apply(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
