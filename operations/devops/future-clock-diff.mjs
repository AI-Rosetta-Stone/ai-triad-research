#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Impure CLI shim for future-clock-diff-predicate.mjs (t/4279). Reads the two vitest JSON
// reports + the known-harness-artifacts exclusion list from disk, computes the diff, and writes
// the summary to $GITHUB_STEP_SUMMARY (or stdout, outside CI). Always exits 0 — this is a
// warn-only observability job; a crashed leg is reported IN the summary (formatSummary's WARN),
// never as a job failure, per the fallback-logging convention (root AGENTS.md: a silent fallback
// is invisible degradation).
//
// Usage: node future-clock-diff.mjs <baseline.json> <future.json> <known-artifacts.json>

import { readFileSync, appendFileSync } from 'node:fs';
import { collectFailedFullNames, diffNewFailures, formatSummary } from './future-clock-diff-predicate.mjs';

function readJsonOrNull(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`::warning::future-clock-diff: ${label} report at ${path} could not be read (${err.message}) -- treating as a crashed run, not a clean pass.`);
    return null;
  }
}

function main() {
  const [baselinePath, futurePath, artifactsPath] = process.argv.slice(2);
  if (!baselinePath || !futurePath || !artifactsPath) {
    console.error('Usage: node future-clock-diff.mjs <baseline.json> <future.json> <known-artifacts.json>');
    process.exit(2);
  }

  const baselineReport = readJsonOrNull(baselinePath, 'real-clock baseline');
  const futureReport = readJsonOrNull(futurePath, 'future-clock (+365d)');
  const knownArtifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));

  const baselineFailed = collectFailedFullNames(baselineReport);
  const futureFailed = collectFailedFullNames(futureReport);
  const diff = diffNewFailures(baselineFailed, futureFailed, knownArtifacts);
  const summary = formatSummary(diff, {
    baselineCrashed: baselineReport === null,
    futureCrashed: futureReport === null,
  });

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  // Warn-only (t/4279 AC: "never in ci-gate's needs") -- always exit 0 even when new
  // failures were found or a leg crashed; the summary is the signal, not the exit code.
  process.exit(0);
}

main();
