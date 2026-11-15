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

function apply(root) {
  const canonical = readFileSync(path.join(root, 'operations/devops/rate-limit-snapshot-step.yml'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  for (const [file, id] of SNAPSHOT_TARGETS) {
    const p = path.join(root, '.github/workflows', file);
    const lines = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const r = jobRange(lines, id);
    if (!r) { console.log(`MISSING job ${id} in ${file}`); process.exitCode = 1; continue; }
    if (lines.slice(r[0], r[1]).join('\n').endsWith(canonical)) { console.log(`ok (present) ${file}:${id}`); continue; }
    lines.splice(r[1], 0, '', ...canonical.split('\n'));
    writeFileSync(p, lines.join('\n'));
    console.log(`inserted ${file}:${id}`);
  }
}

if (process.argv[2] === '--apply') apply(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
