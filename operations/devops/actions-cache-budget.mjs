// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Actions cache budget alarm (t/4931). ALERT ONLY: this module never deletes a cache.
//
// Why: the repo's 10 GB GitHub Actions cache went over budget twice in two days (10.95 GB, which
// evicted Trivy's DB and broke container builds, then 13.93 GB). Nobody knew until a build broke.
// This alarm fires at 8 GB so there is headroom to act before GitHub starts evicting.
//
// Verdict (operations/devops/gate-verdict.mjs, t/4496):
//   PASS             usage read; total <= threshold.
//   FAIL             usage read; total >  threshold. The alert body lists the top cache keys, refs
//                    and key prefixes by size, plus non-main refs over 1 GB as cleanup candidates.
//   GATE-UNREADABLE  usage or the cache list could not be read, or came back in an unexpected
//                    shape. No verdict: never read it as clean, and never auto-close on it.
//
// Expected step-ups that are NOT leaks (cache owner, t/102#3): `hf-embed-Linux-*` is ~600 MB and
// rotates once (~1.2 GB during the overlap), and the ONNX model cache rotates once. That is why
// the alert lists the top individual keys with their refs: two same-prefix keys of the same size
// is a rotation; many keys or a growing prefix total is runaway growth.
//
// Units: decimal GB (1 GB = 1,000,000,000 bytes), matching how the incidents above were reported.
//
// Pure core: keyPrefix, evaluateCacheBudget, formatAlertBody. I/O shims: fetchCacheData (Octokit,
// for github-script) and the CLI at the bottom (`gh api`, read-only, for a local live check).
//
// Run the tests: node --test operations/devops/actions-cache-budget.test.mjs
// Live check (read-only): node operations/devops/actions-cache-budget.mjs [--repo owner/name] [--threshold-gb 8]

import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERDICTS, makeGateVerdict, classifyReadFailure } from './gate-verdict.mjs';

export const GATE_NAME = 'actions-cache-budget';
export const GB = 1_000_000_000;
export const DEFAULT_THRESHOLD_BYTES = 8 * GB;
export const CLEANUP_CANDIDATE_BYTES = 1 * GB;
export const MAIN_REF = 'refs/heads/main';
export const ALERT_LABEL = 'cache-budget-alert';

/** PURE. Bytes as "x.xx GB" (decimal). */
export function formatGb(bytes) {
  return `${(Number(bytes) / GB).toFixed(2)} GB`;
}

// Trailing segments that vary per cache entry: hex digests (optionally `sha256:`-prefixed) and
// ISO dates. `buildkit-blob-1-sha256:<hex>` -> `buildkit-blob-1`; `ai-triad-data-v2-2026-11-10`
// -> `ai-triad-data-v2`; `hf-embed-Linux-<hex>` -> `hf-embed-Linux`.
const VARYING_SUFFIX_RE = /(?:-(?:sha256:)?[0-9a-f]{12,}|-\d{4}-\d{2}-\d{2}(?:T[0-9:.]*Z?)?)+$/i;

/** PURE. The stable prefix of a cache key (its varying hash/date tail removed). */
export function keyPrefix(key) {
  const k = String(key ?? '');
  const stripped = k.replace(VARYING_SUFFIX_RE, '');
  return stripped || k;
}

function sumBy(caches, keyFn) {
  const totals = new Map();
  for (const c of caches) {
    const k = keyFn(c);
    const cur = totals.get(k) || { bytes: 0, count: 0 };
    cur.bytes += c.size_in_bytes;
    cur.count += 1;
    totals.set(k, cur);
  }
  return [...totals.entries()]
    .map(([name, v]) => ({ name, bytes: v.bytes, count: v.count }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function unreadable(reason) {
  return {
    ...makeGateVerdict({ gate: GATE_NAME, verdict: VERDICTS.UNREADABLE, reason }),
    shouldAlert: false,
    canAutoClose: false,
  };
}

const isByteCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * PURE. Decide the cache budget verdict.
 * @param {{
 *   usage?: {active_caches_size_in_bytes: number, active_caches_count?: number},
 *   caches?: Array<{key: string, ref: string, size_in_bytes: number, last_accessed_at?: string}>,
 *   readError?: unknown,
 *   thresholdBytes?: number,
 *   topN?: number,
 * }} input
 */
export function evaluateCacheBudget({ usage, caches, readError, thresholdBytes = DEFAULT_THRESHOLD_BYTES, topN = 10 } = {}) {
  if (readError !== undefined && readError !== null) {
    return unreadable(`could not read the Actions cache API: ${classifyReadFailure(readError)}`);
  }
  if (!usage || !isByteCount(usage.active_caches_size_in_bytes)) {
    return unreadable(
      `cache usage response has no numeric active_caches_size_in_bytes (got ${JSON.stringify(usage ?? null).slice(0, 200)})`,
    );
  }
  if (!Array.isArray(caches)) {
    return unreadable('cache list response is not an array of caches');
  }
  const bad = caches.find((c) => !c || typeof c.key !== 'string' || !isByteCount(c.size_in_bytes));
  if (bad) {
    return unreadable(`cache list has an entry without a string key and numeric size_in_bytes: ${JSON.stringify(bad).slice(0, 200)}`);
  }

  const totalBytes = usage.active_caches_size_in_bytes;
  const listedBytes = caches.reduce((s, c) => s + c.size_in_bytes, 0);
  const norm = caches.map((c) => ({ ...c, ref: c.ref || '(no ref)' }));
  const byRef = sumBy(norm, (c) => c.ref);
  const topKeys = [...norm]
    .sort((a, b) => b.size_in_bytes - a.size_in_bytes || a.key.localeCompare(b.key))
    .slice(0, topN)
    .map((c) => ({ key: c.key, ref: c.ref, bytes: c.size_in_bytes, lastAccessedAt: c.last_accessed_at || '' }));
  const cleanupCandidates = byRef.filter((r) => r.name !== MAIN_REF && r.bytes > CLEANUP_CANDIDATE_BYTES);

  const over = totalBytes > thresholdBytes;
  const reason = `${formatGb(totalBytes)} used across ${usage.active_caches_count ?? caches.length} caches; threshold ${formatGb(thresholdBytes)}`;
  const details = [];
  if (caches.length > 0 && Math.abs(listedBytes - totalBytes) > 0.05 * totalBytes) {
    details.push(`WARN: the cache list sums to ${formatGb(listedBytes)} but usage reports ${formatGb(totalBytes)}; the usage endpoint can lag. The verdict uses the usage total.`);
  }
  return {
    ...makeGateVerdict({ gate: GATE_NAME, verdict: over ? VERDICTS.FAIL : VERDICTS.PASS, reason, details }),
    shouldAlert: over,
    canAutoClose: !over,
    totalBytes,
    listedBytes,
    cacheCount: usage.active_caches_count ?? caches.length,
    thresholdBytes,
    topKeys,
    topRefs: byRef.slice(0, topN),
    topPrefixes: sumBy(norm, (c) => keyPrefix(c.key)).slice(0, topN),
    cleanupCandidates,
  };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/`/g, "'");

/** PURE. The markdown body for the alert issue / comment. */
export function formatAlertBody(result, { runUrl = '', now = new Date().toISOString() } = {}) {
  const lines = [
    `## Actions cache over budget (t/4931)`,
    '',
    `**${formatGb(result.totalBytes)}** in use across ${result.cacheCount} caches, over the ${formatGb(result.thresholdBytes)} alarm threshold. GitHub evicts at 10 GB, and an eviction already broke container builds once (Trivy's DB).`,
    '',
    `Checked ${now}.${runUrl ? ` Run: ${runUrl}` : ''}`,
    '',
    '### Top cache keys',
    '',
    '| Size | Ref | Key |',
    '|---:|---|---|',
    ...result.topKeys.map((k) => `| ${formatGb(k.bytes)} | \`${cell(k.ref)}\` | \`${cell(k.key)}\` |`),
    '',
    '### Top key prefixes',
    '',
    '| Size | Entries | Prefix |',
    '|---:|---:|---|',
    ...result.topPrefixes.map((p) => `| ${formatGb(p.bytes)} | ${p.count} | \`${cell(p.name)}\` |`),
    '',
    '### Top refs',
    '',
    '| Size | Entries | Ref |',
    '|---:|---:|---|',
    ...result.topRefs.map((r) => `| ${formatGb(r.bytes)} | ${r.count} | \`${cell(r.name)}\` |`),
    '',
    '### Cleanup candidates (non-main refs over 1 GB)',
    '',
  ];
  if (result.cleanupCandidates.length === 0) lines.push('None.');
  else for (const c of result.cleanupCandidates) lines.push(`- \`${cell(c.name)}\`: ${formatGb(c.bytes)} in ${c.count} caches`);
  for (const d of result.details || []) lines.push('', d);
  lines.push(
    '',
    '### Reading this',
    '',
    '- **Rotation, not a leak:** `hf-embed-Linux-*` (~600 MB) and the ONNX model cache each rotate once, so two same-size keys under one prefix (~1.2 GB for hf-embed) during the overlap is expected (t/102#3). The old key ages out.',
    '- **Runaway growth:** many keys under one prefix, a prefix total that keeps rising across alerts, or large non-main refs.',
    '- This alarm never deletes caches. `cache-cleanup.yml` runs weekly; manual cleanup is a human decision.',
    '',
    'This issue auto-closes when usage drops back to or under the threshold.',
  );
  return lines.join('\n');
}

/**
 * I/O shim for github-script. Reads usage and every page of the cache list. Throws on API error;
 * the caller passes the error to evaluateCacheBudget as readError.
 */
export async function fetchCacheData(github, owner, repo) {
  const { data: usage } = await github.rest.actions.getActionsCacheUsage({ owner, repo });
  const caches = await github.paginate(
    github.rest.actions.getActionsCacheList,
    { owner, repo, per_page: 100 },
    (resp) => resp.data.actions_caches ?? resp.data,
  );
  return { usage, caches };
}

// ── CLI (read-only live check via `gh api`) ─────────────────────────────────────────────────────
async function main(argv) {
  const { execFileSync } = await import('node:child_process');
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const repo = arg('--repo', 'AI-Rosetta-Stone/ai-triad-research');
  const thresholdBytes = Number(arg('--threshold-gb', '8')) * GB;
  const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  let input;
  try {
    const usage = gh(`repos/${repo}/actions/cache/usage`);
    const caches = [];
    for (let page = 1; ; page++) {
      const data = gh(`repos/${repo}/actions/caches?per_page=100&page=${page}`);
      caches.push(...(data.actions_caches || []));
      if (!data.actions_caches || data.actions_caches.length < 100) break;
    }
    input = { usage, caches, thresholdBytes };
  } catch (err) {
    console.warn(`WARN: could not read the Actions cache API for ${repo}; reporting GATE-UNREADABLE, not clean.`);
    input = { readError: err, thresholdBytes };
  }
  const result = evaluateCacheBudget(input);
  console.log(`${result.gate}: ${result.verdict} - ${result.reason}`);
  if (result.verdict === VERDICTS.FAIL) console.log(`\n${formatAlertBody(result)}`);
  return result.verdict === VERDICTS.UNREADABLE ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
