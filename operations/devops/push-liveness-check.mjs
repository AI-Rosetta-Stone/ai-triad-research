#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/4126: impure CLI shim for pushLivenessVerdict (main-ci-monitor.mjs). Walks recent commits on
// main, determines per-commit whether a push-event ci.yml run exists for that exact SHA and
// whether the file set is docs-only, and whether GitHub's Activity API even listed the PushEvent
// (the ticket's observability ask — separates "GitHub didn't deliver the event" from "our
// trigger/filter didn't match"). Prints a JSON verdict; never throws past this file (CANNOT
// EVALUATE must fail loud, matching main-ci-monitor.mjs's own CLI shim convention).
//
//   node push-liveness-check.mjs <owner/repo>

import { execFileSync } from 'node:child_process';
import { pushLivenessVerdict, isDocsOnlyPush, PUSH_LIVENESS_DEADLINE_MS } from './main-ci-monitor.mjs';

const repo = process.argv[2] || process.env.GITHUB_REPOSITORY;
const gh = (args) => execFileSync('gh', args, { windowsHide: true, encoding: 'utf8', timeout: 30000 });
const ghJson = (path) => JSON.parse(gh(['api', path]));

let out;
try {
  // Window: 2x the deadline, so a commit right at the edge of the deadline still has its
  // full neighborhood of later commits visible for descendant-run coverage.
  const windowMs = PUSH_LIVENESS_DEADLINE_MS * 2;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const rawCommits = ghJson(`repos/${repo}/commits?sha=main&since=${encodeURIComponent(sinceIso)}&per_page=100`);
  // GitHub returns newest-first; pushLivenessVerdict wants oldest-first (descendant coverage scan).
  const commitsNewestFirst = Array.isArray(rawCommits) ? rawCommits : [];
  const commitsOldestFirst = [...commitsNewestFirst].reverse();

  let pushEventShas = new Set();
  try {
    const activity = ghJson(`repos/${repo}/activity?ref=refs/heads/main&per_page=30`);
    pushEventShas = new Set((Array.isArray(activity) ? activity : []).map((a) => a.after).filter(Boolean));
  } catch {
    // Activity API failure must not sink the whole check — pushEventListed degrades to
    // "unknown" (false) for observability only; it never gates the alert decision.
  }

  const commits = commitsOldestFirst.map((c) => {
    const sha = c.sha;
    const committedAtMs = new Date(c.commit.committer.date).getTime();
    let files = [];
    try {
      const detail = ghJson(`repos/${repo}/commits/${sha}`);
      files = (detail.files ?? []).map((f) => f.filename);
    } catch {
      files = []; // unreadable file list -> isDocsOnlyPush fails toward checking it.
    }
    let hasRun = false;
    try {
      const runs = ghJson(`repos/${repo}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=1`);
      hasRun = Number(runs.total_count ?? 0) > 0;
    } catch {
      hasRun = false; // unreadable -> treated as no run (fail toward alerting, not silence).
    }
    return {
      sha,
      committedAtMs,
      docsOnly: isDocsOnlyPush(files),
      hasRun,
      pushEventListed: pushEventShas.has(sha),
    };
  });

  const verdict = pushLivenessVerdict({ commits, nowMs: Date.now() });
  out = { ok: true, commitsChecked: commits.length, verdict };
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exitCode = out.ok ? 0 : 3;
