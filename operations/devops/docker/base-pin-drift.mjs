// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Base-image pin drift check (t/255, Orca t/4943 arm 1).
//
// taxonomy-editor/Dockerfile's runtime stage pins ghcr.io/ai-rosetta-stone/ai-triad-base by date
// tag AND digest. base-image.yml rebuilds that image weekly (and on a Dockerfile.base push) to
// retire CVEs, but nothing moved the pin. On 2026-11-08 the rebuild fixed CVE-2026-76844 while the
// pin stayed old, and container builds failed Trivy for days with no alert. The same tag can also
// be re-pushed the same day, so drift is a digest comparison, not only a tag comparison.
//
// Three-state verdict (docs/CodeReview/gate-signal-integrity.md, t/4496):
//   PASS             pin == the newest date tag and its current digest in GHCR
//   FAIL             pin differs from it (the workflow opens a re-pin PR or an issue)
//   GATE-UNREADABLE  the Dockerfile pin or the registry could not be read; never a pass
//
// CLI (used by .github/workflows/check-base-pin-drift.yml):
//   node base-pin-drift.mjs check <dockerfile>             verdict -> $GITHUB_OUTPUT / summary
//   node base-pin-drift.mjs repin <dockerfile> <tag> <digest>   rewrite the runtime FROM line
//   node base-pin-drift.mjs pr-body <before> <after> <file>     tier (T0 only for a pure pin bump) + PR body
//
// Tests: node --test operations/devops/docker/base-pin-drift.test.mjs

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  VERDICTS,
  makeGateVerdict,
  classifyReadFailure,
  formatVerdictOutputs,
  formatVerdictSummary,
} from '../gate-verdict.mjs';

export const GATE = 'base-pin-drift';
export const IMAGE = 'ghcr.io/ai-rosetta-stone/ai-triad-base';
export const REPO_PATH = 'ai-rosetta-stone/ai-triad-base';
export const BRANCH_PREFIX = 'docker/base-repin-';

const DATE_TAG = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_FROM = /^FROM\s+ghcr\.io\/ai-rosetta-stone\/ai-triad-base:(\S+?)@(sha256:[0-9a-f]{64})\s+AS\s+runtime\s*$/i;

/** PURE. The runtime stage's base pin, or null when no single well-formed pin line exists. */
export function parseRuntimePin(dockerfileText) {
  const lines = String(dockerfileText).split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    const m = RUNTIME_FROM.exec(line.trim());
    if (m) hits.push({ tag: m[1], digest: m[2], lineIndex: index });
  });
  return hits.length === 1 ? hits[0] : null;
}

/** PURE. The newest YYYY-MM-DD tag, or null. `latest` and other tags are ignored. */
export function pickLatestDateTag(tags) {
  const dated = (tags || []).filter((t) => DATE_TAG.test(t)).sort();
  return dated.length ? dated[dated.length - 1] : null;
}

/**
 * PURE. Compare the pin with the registry's newest date tag.
 * `pin` comes from parseRuntimePin (null = unparseable). `latest` is {tag, digest} or an
 * {error} describing why the registry could not be read.
 */
export function evaluateDrift({ pin, latest }) {
  if (!pin) {
    return makeGateVerdict({
      gate: GATE,
      verdict: VERDICTS.UNREADABLE,
      reason: `no single 'FROM ${IMAGE}:<tag>@sha256:<digest> AS runtime' line in taxonomy-editor/Dockerfile`,
    });
  }
  if (!latest || latest.error) {
    return makeGateVerdict({
      gate: GATE,
      verdict: VERDICTS.UNREADABLE,
      reason: latest && latest.error ? latest.error : 'registry returned nothing',
    });
  }
  if (!latest.tag || !DIGEST.test(latest.digest || '')) {
    return makeGateVerdict({
      gate: GATE,
      verdict: VERDICTS.UNREADABLE,
      reason: `registry answer is not a date tag plus sha256 digest (tag='${latest.tag}', digest='${latest.digest}')`,
    });
  }
  const details = [`pinned: ${pin.tag}@${pin.digest}`, `latest: ${latest.tag}@${latest.digest}`];
  if (DATE_TAG.test(pin.tag) && pin.tag > latest.tag) {
    // The registry's newest tag is older than what main pins: the tag list is wrong or truncated.
    return makeGateVerdict({
      gate: GATE,
      verdict: VERDICTS.UNREADABLE,
      reason: `pinned tag ${pin.tag} is newer than the registry's newest date tag ${latest.tag}; the tag list looks incomplete`,
      details,
    });
  }
  if (pin.tag === latest.tag && pin.digest === latest.digest) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.PASS, details });
  }
  const why = pin.tag === latest.tag ? `tag ${pin.tag} was re-pushed with a new digest` : `newer base ${latest.tag} exists`;
  return makeGateVerdict({ gate: GATE, verdict: VERDICTS.FAIL, reason: `pin is stale: ${why}`, details });
}

/** PURE. Dockerfile text with only the runtime FROM line re-pinned. Throws if it can't. */
export function repinDockerfile(dockerfileText, { tag, digest }) {
  if (!DATE_TAG.test(tag) || !DIGEST.test(digest)) {
    throw new Error(`repinDockerfile: refusing tag='${tag}' digest='${digest}' (want YYYY-MM-DD and sha256:<64 hex>)`);
  }
  const pin = parseRuntimePin(dockerfileText);
  if (!pin) throw new Error('repinDockerfile: no single runtime FROM line to re-pin');
  const eol = String(dockerfileText).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(dockerfileText).split(/\r?\n/);
  lines[pin.lineIndex] = `FROM ${IMAGE}:${tag}@${digest} AS runtime`;
  return lines.join(eol);
}

/** PURE. The re-pin branch. The digest prefix keeps a same-day re-push distinct. */
export function repinBranch({ tag, digest }) {
  return `${BRANCH_PREFIX}${tag}-${digest.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

/**
 * PURE. The tier a re-pin PR may declare (t/305; PI decision 4, TL guardrail p/103#19).
 * `Tier: T0` makes the T0 enqueue sweep merge it with no human, so T0 is allowed ONLY when the
 * change is exactly one line, that line is the runtime FROM before and after, and both point at
 * our own ai-triad-base (RUNTIME_FROM matches only that image) with a date tag and digest.
 * Anything else is T1, so `Tier: T0` can't carry another Dockerfile edit.
 * @returns {{tier: 'T0'|'T1', reason: string}}
 */
export function classifyRepinTier(beforeText, afterText) {
  const t1 = (reason) => ({ tier: 'T1', reason });
  const before = String(beforeText).split(/\r?\n/);
  const after = String(afterText).split(/\r?\n/);
  if (before.length !== after.length) return t1(`line count changed (${before.length} -> ${after.length})`);
  const changed = [];
  before.forEach((line, i) => { if (line !== after[i]) changed.push(i); });
  if (changed.length !== 1) return t1(`${changed.length} lines changed, want exactly 1`);
  const i = changed[0];
  const was = RUNTIME_FROM.exec(before[i].trim());
  const now = RUNTIME_FROM.exec(after[i].trim());
  if (!was || !now) return t1(`line ${i + 1} is not the '${IMAGE}:<tag>@sha256:<digest> AS runtime' line on both sides`);
  if (!DATE_TAG.test(was[1]) || !DATE_TAG.test(now[1])) return t1('tag is not YYYY-MM-DD on both sides');
  if (was[1] === now[1] && was[2] === now[2]) return t1('pin did not change');
  return { tier: 'T0', reason: 'only the runtime ai-triad-base tag/digest changed (dependency bump, docs/change-tiers.md)' };
}

/**
 * PURE. The re-pin PR body. Line 1 is the tier (AGENTS.md); the body names old -> new tag and
 * digest and the Base Image run that produced the new one (TL guardrail p/103#19).
 */
export function repinPrBody({ tier, tierReason, reason, dockerfile, pinned, latest, baseImageRun, driftRun }) {
  return [
    `Tier: ${tier}`,
    '',
    `Automated re-pin from \`check-base-pin-drift.yml\` (t/255, t/305): ${reason}.`,
    '',
    '| | tag | digest |',
    '|---|---|---|',
    `| was | \`${pinned.tag}\` | \`${pinned.digest}\` |`,
    `| now | \`${latest.tag}\` | \`${latest.digest}\` |`,
    '',
    `- Base Image run that produced it: ${baseImageRun || 'not found (WARN: no successful base-image.yml run listed)'}`,
    `- Drift check run: ${driftRun}`,
    `- Tier ${tier}: ${tierReason}.`,
    '',
    tier === 'T0'
      ? `Only the runtime \`FROM\` line of \`${dockerfile}\` changes. The T0 enqueue sweep merges this once the required checks (ci-gate, which includes test-container) are green; \`dockerfile-trivy\` reports but doesn't block (PI decision 2, t/249).`
      : `This change is more than a runtime pin bump, so it needs a T1 review (owner of \`${dockerfile}\` + Quality) before merge.`,
    '',
  ].join('\n');
}

// ---- I/O below -------------------------------------------------------------------------------

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function httpError(res, what) {
  const err = new Error(`${what}: HTTP ${res.status} ${res.statusText}`);
  err.status = res.status;
  return err;
}

/** Newest date tag and its digest from GHCR (anonymous pull token; the image is public). */
export async function readLatestFromGhcr(fetchImpl = fetch) {
  try {
    const tokRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${REPO_PATH}:pull`);
    if (!tokRes.ok) throw await httpError(tokRes, 'GHCR token');
    const { token } = await tokRes.json();
    const auth = { Authorization: `Bearer ${token}` };
    const tags = [];
    let url = `https://ghcr.io/v2/${REPO_PATH}/tags/list?n=1000`;
    for (let page = 0; url && page < 50; page++) {
      const res = await fetchImpl(url, { headers: auth });
      if (!res.ok) throw await httpError(res, 'GHCR tags/list');
      tags.push(...((await res.json()).tags || []));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
      url = next ? new URL(next[1], 'https://ghcr.io').href : null;
    }
    const tag = pickLatestDateTag(tags);
    if (!tag) return { error: `no YYYY-MM-DD tag among ${tags.length} tag(s) of ${IMAGE}` };
    const head = await fetchImpl(`https://ghcr.io/v2/${REPO_PATH}/manifests/${tag}`, {
      method: 'HEAD',
      headers: { ...auth, Accept: MANIFEST_ACCEPT },
    });
    if (!head.ok) throw await httpError(head, `GHCR manifest ${tag}`);
    return { tag, digest: head.headers.get('docker-content-digest') };
  } catch (err) {
    return { error: classifyReadFailure(err) };
  }
}

function appendFile(envName, text) {
  const target = process.env[envName];
  if (target) fs.appendFileSync(target, text);
}

async function check(dockerfilePath) {
  let text = null;
  try {
    text = fs.readFileSync(dockerfilePath, 'utf8');
  } catch (err) {
    console.log(`::warning::WARN: ${GATE}: could not read ${dockerfilePath}: ${err.message}`);
  }
  const pin = text === null ? null : parseRuntimePin(text);
  const latest = await readLatestFromGhcr();
  const v = evaluateDrift({ pin, latest });

  const out = formatVerdictOutputs(v);
  const lines = Object.entries(out).map(([k, val]) => `${k}=${val}`);
  if (latest && !latest.error) {
    lines.push(`latest_tag=${latest.tag}`, `latest_digest=${latest.digest}`, `branch=${repinBranch(latest)}`);
  }
  if (pin) lines.push(`pinned_tag=${pin.tag}`, `pinned_digest=${pin.digest}`);
  appendFile('GITHUB_OUTPUT', `${lines.join('\n')}\n`);
  appendFile('GITHUB_STEP_SUMMARY', `${formatVerdictSummary(v)}\n`);

  console.log(`${GATE}: ${v.verdict}${v.reason ? ` (${v.reason})` : ''}`);
  for (const d of v.details) console.log(`  ${d}`);
  if (v.verdict !== VERDICTS.PASS) console.log(`::warning::${GATE}: ${v.verdict}: ${v.reason}`);
  // An unreadable target fails the run so a broken check is visible, not a quiet green.
  return v.verdict === VERDICTS.UNREADABLE ? 1 : 0;
}

function repin(dockerfilePath, tag, digest) {
  const text = fs.readFileSync(dockerfilePath, 'utf8');
  fs.writeFileSync(dockerfilePath, repinDockerfile(text, { tag, digest }));
  console.log(`${GATE}: re-pinned ${dockerfilePath} to ${tag}@${digest}`);
  return 0;
}

/**
 * Tier + PR body for a re-pin, judged on the file as committed on main (`before`) vs the
 * working copy (`after`). Inputs beyond the paths come from the workflow's env.
 * Writes tier= / tier_reason= to $GITHUB_OUTPUT and the body to <bodyFile>.
 */
function prBody(beforePath, afterPath, bodyFile) {
  const env = process.env;
  const { tier, reason: tierReason } = classifyRepinTier(fs.readFileSync(beforePath, 'utf8'), fs.readFileSync(afterPath, 'utf8'));
  const body = repinPrBody({
    tier,
    tierReason,
    reason: env.REASON,
    dockerfile: env.DOCKERFILE,
    pinned: { tag: env.PINNED_TAG, digest: env.PINNED_DIGEST },
    latest: { tag: env.LATEST_TAG, digest: env.LATEST_DIGEST },
    baseImageRun: env.BASE_IMAGE_RUN,
    driftRun: env.DRIFT_RUN,
  });
  fs.writeFileSync(bodyFile, body);
  appendFile('GITHUB_OUTPUT', `tier=${tier}\ntier_reason=${tierReason}\n`);
  console.log(`${GATE}: re-pin PR tier ${tier} (${tierReason})`);
  if (tier !== 'T0') console.log(`::warning::WARN: ${GATE}: re-pin PR opens as ${tier}, not T0: ${tierReason}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  let code;
  if (cmd === 'check' && rest.length === 1) code = await check(rest[0]);
  else if (cmd === 'repin' && rest.length === 3) code = repin(...rest);
  else if (cmd === 'pr-body' && rest.length === 3) code = prBody(...rest);
  else {
    console.error('usage: base-pin-drift.mjs check <dockerfile> | repin <dockerfile> <tag> <digest> | pr-body <before> <after> <body-file>');
    code = 2;
  }
  process.exit(code);
}
