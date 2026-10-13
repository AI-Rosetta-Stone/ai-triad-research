#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4180 — impure driver for the staging load-test harness. Drives three virtual-user
// (VU) profiles against a taxonomy-editor server over a ramp of concurrency levels and
// reports the measured per-level stats via load-test-core.mjs's pure summary/verdict.
//
// Deliberately dependency-free (built-in fetch only, Node 18+) — every other operations/
// devops/*.mjs script in this repo follows the same no-new-npm-dependency convention
// (see gate-telemetry.mjs, collect-flake-heal-runs.mjs, etc.), and k6/autocannon are not
// installed here. This is NOT a general-purpose load tool: it exists to answer t/4180's
// one question (measured per-container session capacity) with the three profiles the
// ticket specifies, nothing more.
//
// SAFETY: this script never inspects its --base-url for a "looks like prod" guard —
// that check lives in the PS wrapper (Invoke-TaxEditorLoadTest.ps1), which is the only
// supported entry point. Do not invoke this file directly against a URL you have not
// already verified is staging.

import { summarizeStep, findBreakingPoint } from './load-test-core.mjs';

function parseArgs(argv) {
  const args = { levels: [5, 10, 25, 50, 100], durationSec: 60, profiles: ['reader', 'editor', 'debater'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--levels') args.levels = argv[++i].split(',').map(Number);
    else if (a === '--duration-sec') args.durationSec = Number(argv[++i]);
    else if (a === '--profiles') args.profiles = argv[++i].split(',');
    else if (a === '--debater-backend') args.debaterBackend = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  if (!args.baseUrl) throw new Error('--base-url is required');
  // Non-Gemini free-tier backend by default — satisfies the ticket's "spends no Gemini
  // quota" requirement without a server-side stub mode, which does not exist today
  // (featureFlags.ts has no debate-backend-override flag as of t/4180). Documented in
  // README.md under "Debater profile backend choice".
  args.debaterBackend ??= 'groq-openai-gpt-oss-20b';
  return args;
}

async function timedFetch(url, init) {
  const start = performance.now();
  try {
    const res = await fetch(url, init);
    const elapsedMs = performance.now() - start;
    // Drain the body so keep-alive sockets are reusable and we measure a complete
    // response, not just headers.
    await res.arrayBuffer().catch(() => {});
    return { elapsedMs, ok: res.ok, status: res.status };
  } catch (err) {
    return { elapsedMs: performance.now() - start, ok: false, status: 0, error: String(err) };
  }
}

// CORRECTION (found while analyzing the first live run, t/4180): every unauthenticated
// request to an /api/* route was served Azure Easy Auth's HTML sign-in interstitial —
// 200 OK, content-type text/html — not the application's JSON response. The driver
// never carried a session cookie, so the entire first ramp (reader + editor + debater,
// all three) measured the cost of serving a static login page, not real app behavior
// (confirmed via a direct curl: every endpoint 200'd HTML with no cookie, then returned
// real JSON once a `/.auth/anonymous` cookie was attached). Each VU now bootstraps one
// anonymous session before its loop and sends that cookie on every request.
async function bootstrapAnonSession(baseUrl) {
  const res = await fetch(`${baseUrl}/.auth/anonymous`, { redirect: 'manual' });
  await res.arrayBuffer().catch(() => {});
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  if (cookies.length === 0) return null;
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

const POVS = ['acc', 'saf', 'skp', 'cc'];
function randomPov() { return POVS[Math.floor(Math.random() * POVS.length)]; }

/** One iteration of the reader profile: browse + search, no writes. */
async function readerIteration(baseUrl, cookie) {
  const headers = cookie ? { cookie } : undefined;
  const results = [];
  results.push(await timedFetch(`${baseUrl}/api/taxonomy-dirs`, { headers }));
  results.push(await timedFetch(`${baseUrl}/api/taxonomy/${randomPov()}`, { headers }));
  return results;
}

/** Editor profile: reader traffic, plus roughly one save every ~2 minutes of VU
 *  lifetime (modeled as a per-iteration probability so it doesn't require tracking
 *  wall-clock state across iterations). Staging-only by construction — this script is
 *  never pointed at prod (enforced by the PS wrapper, not here). */
let editorIterationMs = 0;
async function editorIteration(baseUrl, iterationIntervalMsEstimate, cookie) {
  const headers = cookie ? { cookie } : undefined;
  const results = await readerIteration(baseUrl, cookie);
  editorIterationMs += iterationIntervalMsEstimate;
  if (editorIterationMs >= 120_000) {
    editorIterationMs = 0;
    const pov = randomPov();
    // Idempotent no-op PUT: read-then-write-the-same-document, so the "save" exercises
    // the write path and session-branch machinery under load without corrupting the
    // staging taxonomy content.
    const getResult = await timedFetch(`${baseUrl}/api/taxonomy/${pov}`, { headers });
    results.push(getResult);
    if (getResult.ok) {
      // The GET body isn't retained (timedFetch drains it) — re-fetch is wasteful but
      // keeps this driver dependency-free and the PUT body honest (same shape the
      // client would send). Acceptable: saves are ~1/120s of editor traffic.
      const body = await fetch(`${baseUrl}/api/taxonomy/${pov}`, { headers }).then((r) => r.text()).catch(() => null);
      if (body) {
        results.push(await timedFetch(`${baseUrl}/api/taxonomy/${pov}`, {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/json' },
          body,
        }));
      }
    }
  }
  return results;
}

/** Debater profile: a real AI-generation call against a free-tier non-Gemini backend.
 *
 * CORRECTION (found while analyzing the first live run, t/4180): there is no
 * `POST /api/debates` route — debate persistence is `PUT /api/debates` (a session-save,
 * not a generation call), and debate orchestration itself happens client-side, turn by
 * turn, through the generic `POST /api/ai/generate` proxy. The original `POST
 * /api/debates` call silently 200'd (SPA static-file fallback for an unmatched path)
 * with near-flat ~100ms latency and 0% errors at every concurrency — it measured static-
 * file serving, not debate-start cost. Switched to `/api/ai/generate`, which is the real
 * endpoint a debate turn calls. `debateId` is deliberately OMITTED: `/api/ai/generate`
 * blocks anonymous+free-tier requests that carry a `debateId` (t/3230's anon-debate gate)
 * — sending one would 403 every request on an anonymous session, not exercise AI load. */
async function debaterIteration(baseUrl, backendId, cookie) {
  return [await timedFetch(`${baseUrl}/api/ai/generate`, {
    method: 'POST',
    headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Load-test probe: respond with a single short sentence.',
      model: backendId,
    }),
  })];
}

const PROFILE_ITERATION = { reader: readerIteration, editor: editorIteration, debater: debaterIteration };

/** Run `concurrency` VUs of one profile for durationSec, collecting latencies/errors. */
async function runStep({ baseUrl, profile, concurrency, durationSec, debaterBackend }) {
  const deadline = Date.now() + durationSec * 1000;
  const latenciesMs = [];
  let errorCount = 0;
  let requestCount = 0;
  // Rough per-VU iteration pacing so `editor`'s 2-minute save cadence is approximated in
  // wall-clock terms regardless of how fast individual requests return.
  const vu = async () => {
    const cookie = await bootstrapAnonSession(baseUrl).catch(() => null);
    while (Date.now() < deadline) {
      const iterStart = Date.now();
      let samples;
      if (profile === 'editor') samples = await editorIteration(baseUrl, 1000, cookie);
      else if (profile === 'debater') samples = await debaterIteration(baseUrl, debaterBackend, cookie);
      else samples = await readerIteration(baseUrl, cookie);
      for (const s of samples) {
        requestCount += 1;
        latenciesMs.push(s.elapsedMs);
        if (!s.ok) errorCount += 1;
      }
      const elapsed = Date.now() - iterStart;
      if (elapsed < 200) await new Promise((r) => setTimeout(r, 200 - elapsed));
    }
  };
  const start = Date.now();
  await Promise.all(Array.from({ length: concurrency }, vu));
  const durationMs = Date.now() - start;
  return summarizeStep({ latenciesMs, errorCount, requestCount, durationMs });
}

async function getGithubRateLimitRemaining() {
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], { encoding: 'utf8' });
    return Number(out.trim());
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = [];
  for (const profile of args.profiles) {
    for (const level of args.levels) {
      process.stderr.write(`[load-test] ${profile} @ concurrency=${level} for ${args.durationSec}s...\n`);
      const summary = await runStep({
        baseUrl: args.baseUrl,
        profile,
        concurrency: level,
        durationSec: args.durationSec,
        debaterBackend: args.debaterBackend,
      });
      const githubRateLimitRemaining = await getGithubRateLimitRemaining();
      const step = { level, profile, ...summary, githubRateLimitRemaining };
      steps.push(step);
      process.stderr.write(`[load-test]   p50=${summary.p50Ms.toFixed(0)}ms p95=${summary.p95Ms.toFixed(0)}ms `
        + `errRate=${summary.errorRatePct.toFixed(2)}% rps=${summary.rps.toFixed(1)} `
        + `ghRemaining=${githubRateLimitRemaining ?? 'n/a'}\n`);
    }
  }
  const breakingPoint = findBreakingPoint(steps);
  const report = { baseUrl: args.baseUrl, debaterBackend: args.debaterBackend, steps, breakingPoint };
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    const fs = await import('node:fs');
    fs.writeFileSync(args.out, json);
  }
  process.stdout.write(json + '\n');
}

main().catch((err) => {
  process.stderr.write(`[load-test] FATAL: ${err?.stack || err}\n`);
  process.exitCode = 1;
});
