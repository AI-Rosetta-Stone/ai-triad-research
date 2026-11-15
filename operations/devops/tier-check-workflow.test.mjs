// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4103, e/291: the tier-check skew fallback must judge R1 with SELF-CONTAINED code in the
// workflow, never the PR's own (head) predicate module. These tests extract the exact
// BEGIN/END r1-inline block from .github/workflows/tier-check.yml and run it, so they test the
// code the workflow actually executes, not a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkR6 } from './tier-check-predicate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'tier-check.yml'), 'utf8');
const config = JSON.parse(readFileSync(path.join(root, '.github', 'ci', 'tier-paths.json'), 'utf8'));

function extractBlock() {
  const start = workflow.indexOf('// BEGIN r1-inline');
  const end = workflow.indexOf('// END r1-inline');
  assert.ok(start >= 0 && end > start, 'r1-inline markers must exist in tier-check.yml');
  return workflow.slice(start, end);
}

function loadInline() {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractBlock()}\nreturn inlineR1Fallback;`)();
}

function extractRequirementsNoteBlock() {
  const start = workflow.indexOf('// BEGIN requirements-note');
  const end = workflow.indexOf('// END requirements-note');
  assert.ok(start >= 0 && end > start, 'requirements-note markers must exist in tier-check.yml');
  return workflow.slice(start, end);
}

function loadTierRequirementsNote() {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractRequirementsNoteBlock()}\nreturn tierRequirementsNote;`)();
}

const files = (...names) => names.map((filename) => ({ filename, status: 'modified' }));

test('the inline fallback imports and references no predicate module (head or base)', () => {
  // Code lines only: the block's comment legitimately names the old head call it replaces.
  const block = extractBlock().split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const banned of ['import(', 'require(', 'headModule', 'baseModule', 'evaluateR1Only', 'factsFromListFiles', 'extractTier']) {
    assert.ok(!block.includes(banned), `inline block must not reference ${banned}`);
  }
});

test('r1FallbackCheck calls the inline fallback, not the head module', () => {
  const fn = workflow.slice(workflow.indexOf('async function r1FallbackCheck'), workflow.indexOf('if (baseConfigText === null)'));
  assert.match(fn, /inlineR1Fallback\(files, pr\.body, config\)/);
  assert.ok(!fn.includes('headModule'), 'r1FallbackCheck must not use headModule');
});

test('ATTACK ARM: a predicate-only PR that bumps TIER_CHECK_API and stubs evaluateR1Only still gets R1', () => {
  // The skew path is reached because the head bumped TIER_CHECK_API. Whatever the head module
  // now says (a stubbed evaluateR1Only returning no hits), the fallback never consults it.
  const inline = loadInline();
  const r = inline(files('operations/devops/tier-check-predicate.mjs'), 'Tier: T1 (small fix)', config);
  assert.equal(r.pass, false);
  assert.deepEqual(r.comments, ['R1: touches operations/devops/tier-check-predicate.mjs, must declare Tier: T2']);
});

test('CONTROL: a non-R1 PR on the same skew path stays a clean skip', () => {
  const r = loadInline()(files('lib/debate/aiAdapter.ts', 'docs/notes.md'), 'Tier: T0', config);
  assert.equal(r.pass, true);
  assert.deepEqual(r.comments, []);
});

test('an R1 path declared T2 passes', () => {
  const r = loadInline()(files('.github/ci/tier-paths.json'), 'Tier: T2 (gate config)', config);
  assert.equal(r.pass, true);
});

test('R1 globs match (Move-PiCredential*.ps1) and a missing tier line still fails', () => {
  const r = loadInline()(files('operations/devops/Move-PiCredentialToKeePass.ps1'), 'no tier line here', config);
  assert.equal(r.pass, false);
  assert.equal(r.tier, null);
});

test('reads the REST listFiles field `filename`, ignoring malformed entries', () => {
  const r = loadInline()([{ path: '.github/ci/tier-paths.json' }, null, { filename: 'README.md' }], 'Tier: T0', config);
  assert.equal(r.pass, true, 'an entry with only `path` (the GraphQL shape) must not count');
});

// ── e/291 SO C1: the head predicate is never imported anywhere in the step ──────────────────
function scriptCodeLines() {
  return workflow.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

// t/4182: the import() check above only ever caught `import()`. A `require(` or a
// `createRequire(...)(...)` of the head predicate text (e.g. the path read at
// `GITHUB_WORKSPACE/.../tier-check-predicate.mjs`) would execute the untrusted head code just
// as surely, and this test previously would not have noticed. Pure, so a fixture string can
// drive it without a real workflow file.
function structureIssues(code) {
  const issues = [];
  const imports = code.match(/import\([^)]*\)/g) ?? [];
  // Exactly two imports, both base-tip temp files (git show, never the PR tree): the predicate,
  // and the t/4819 GitHub retry helper (github-retry-workflow.test.mjs pins its git-show source).
  const allowed = ['import(pathToFileURL(helperPath)', 'import(pathToFileURL(predicatePath)'];
  if (!(imports.length === allowed.length && [...imports].sort().every((imp, i) => imp === allowed[i]))) {
    issues.push(`unexpected imports: ${imports.join(' | ')}`);
  }
  if (code.includes('headModule')) issues.push('no headModule binding may exist');
  const headRequires = [...code.matchAll(/require\(([^)]*)\)/g)].filter(([, arg]) => arg.includes('tier-check-predicate'));
  if (headRequires.length) issues.push(`head predicate must not be require()'d: ${headRequires.map((m) => m[0]).join(', ')}`);
  if (code.includes('createRequire')) {
    issues.push("createRequire must not appear (it can dynamically require the head predicate, bypassing the text-read discipline)");
  }
  return issues;
}

test('C1: the whole step imports only the BASE copy (a temp file), never the head predicate', () => {
  const code = scriptCodeLines();
  assert.deepEqual(structureIssues(code), []);
  assert.match(code, /readFromHead\('operations\/devops\/tier-check-predicate\.mjs'\)/,
    'the head predicate is read as TEXT, through the API (t/4266 P1 -- never a local checkout of the head)');
  assert.match(code, /baseModule\.checkApiVersion\(baseModule\.TIER_CHECK_API, headApi\)/, 'the version check runs base code');
});

test('RED ARM (t/4819): the two allowed base-tip imports plus any third import still fail the structure check', () => {
  const fixture = `
    await import(pathToFileURL(helperPath).href);
    await import(pathToFileURL(predicatePath).href);
    await import(pathToFileURL(headPredicatePath).href);
  `;
  assert.ok(structureIssues(fixture).some((i) => i.startsWith('unexpected imports')));
  const swapped = `
    await import(pathToFileURL(helperPath).href);
    await import(pathToFileURL(headPredicatePath).href);
  `;
  assert.ok(structureIssues(swapped).some((i) => i.startsWith('unexpected imports')), 'helper + a non-predicate import must fail');
});

// ── t/4266 P1: pull_request_target migration -- the workflow file itself is sourced from
// `main`, never the PR, and the job never checks out or git-diffs the PR's head commit ──────
test('P1: triggers on pull_request_target, not pull_request (a PR can no longer disable evaluation by editing this file)', () => {
  assert.match(workflow, /^on:\s*\n\s*pull_request_target:/m);
  assert.ok(!/^\s*pull_request:\s*\n\s*types:/m.test(workflow), 'must not also trigger on plain pull_request');
});

test('P1: checkout never persists credentials, and the step never shells `git diff`/`git show` against the head SHA', () => {
  assert.match(workflow, /persist-credentials:\s*false/);
  const code = scriptCodeLines();
  assert.ok(!/git (diff|show) \$\{?headSha/.test(code) && !code.includes('git diff ${baseSha} ${headSha}'),
    'the head commit must never be passed to a local git diff/show -- only to the API (readFromHead/getContent)');
  assert.match(code, /repos\.getContent\(\{ owner, repo, path: repoPath, ref: headSha \}\)/, 'the head is read via the Contents API');
});

test('P1: R2a/R2c diff lines come from the already-fetched pulls.listFiles patch, never a local git diff', () => {
  const code = scriptCodeLines();
  assert.match(code, /filesByPath\.get\(path\)\?\.patch/);
  assert.ok(!code.includes('git diff'), 'no git diff invocation may remain in the step');
});

// ── t/4266: the self-test suite moved to ci.yml's gate-self-health job (plain pull_request,
// zero permissions). This job must have no knowledge of it at all -- a PR that rewrites its own
// predicate's test file to always pass cannot influence THIS verdict, because this job never
// reads any test result and never executes any PR-authored test file in the first place ──────
test('P2 fix 4 (t/4266#13): issue_comment and pull_request_review are triggers, so R6 re-evaluates once approval arrives (no deadlock)', () => {
  // `edited`, `deleted` and `dismissed` (SO condition on #5176): withdrawn evidence must re-evaluate.
  assert.match(workflow, /^\s*issue_comment:\s*\n\s*types: \[created, edited, deleted\]/m);
  assert.match(workflow, /^\s*pull_request_review:\s*\n\s*types: \[submitted, dismissed\]/m);
});

test('P2 fix 4: issue_comment is filtered to PRs via resolvePrNumber, same shape as t1-approval-guard.yml', () => {
  const code = scriptCodeLines();
  assert.match(code, /context\.payload\.issue && context\.payload\.issue\.pull_request/);
});

test('ATTACK ARM (t/4266): fully decoupled from gate-self-health -- rewriting the self-test to always pass cannot touch the verdict', () => {
  assert.ok(!/needs:\s*\[[^\]]*gate-self-health/.test(workflow), 'tier-check.yml\'s job must not declare a `needs:` on the self-test job');
  assert.ok(!/needs\.gate-self-health/.test(workflow), 'the step must not read gate-self-health\'s outcome');
  assert.ok(!scriptCodeLines().includes('node --test'), 'tier-check.yml must never execute a test suite itself (moved to ci.yml, t/4266)');
});

test('CONTROL: legitimate require() of node builtins in the step preamble does not false-positive', () => {
  // require('url'), require('child_process'), require('fs'), require('os'), require('path')
  // are all present in the real step and must not trip the head-require check.
  const code = scriptCodeLines();
  assert.ok(/require\('url'\)/.test(code) && /require\('path'\)/.test(code), 'fixture precondition: builtin requires are present');
  assert.deepEqual(structureIssues(code), []);
});

test('RED ARM: a fixture require()-ing the head predicate path fails the structure check', () => {
  const fixture = `
    const { pathToFileURL } = require('url');
    import(pathToFileURL(predicatePath));
    const headModuleBad = require(path.join(process.env.GITHUB_WORKSPACE, 'operations', 'devops', 'tier-check-predicate.mjs'));
  `;
  const issues = structureIssues(fixture);
  assert.ok(issues.some((i) => i.includes("head predicate must not be require()'d")), `expected a head-require issue, got: ${issues.join(' | ')}`);
});

test('RED ARM: a fixture using createRequire fails the structure check', () => {
  const fixture = `
    const { createRequire } = require('module');
    const req = createRequire(import.meta.url);
    import(pathToFileURL(predicatePath));
    req('operations/devops/tier-check-predicate.mjs');
  `;
  const issues = structureIssues(fixture);
  assert.ok(issues.some((i) => i.includes('createRequire')), `expected a createRequire issue, got: ${issues.join(' | ')}`);
});

test('C1: the head API is parsed from text; anything malformed reads as null (forces the skew path)', () => {
  const src = /\/(\^export const TIER_CHECK_API[^\n]*?)\/m\.exec/.exec(workflow);
  assert.ok(src, 'the fixed regex must be present in the workflow');
  const re = new RegExp(src[1], 'm');
  const parse = (t) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  assert.equal(parse('// x\nexport const TIER_CHECK_API = 3;\n'), 3);
  assert.equal(parse('export const TIER_CHECK_API = globalThis.x;'), null, 'a computed value must not parse');
  assert.equal(parse('export let TIER_CHECK_API = 3;'), null);
  assert.equal(parse('  export const TIER_CHECK_API = 3;'), null, 'must be a top-level declaration at line start');
  assert.equal(parse(''), null);
});

// ── e/291 SO C2: a rename away from an R1 path is still an R1 change ──────────────────────
test('C2: a rename AWAY from an R1 path, declared T1, fails (inline fallback)', () => {
  const renamed = [{ filename: 'docs/old-tier-paths.json', previous_filename: '.github/ci/tier-paths.json', status: 'renamed' }];
  const r = loadInline()(renamed, 'Tier: T1', config);
  assert.equal(r.pass, false);
  assert.deepEqual(r.comments, ['R1: touches .github/ci/tier-paths.json, must declare Tier: T2']);
});

test('C2: factsFromListFiles (main path) also judges the previous name of a rename', async () => {
  const { factsFromListFiles, checkR1 } = await import('./tier-check-predicate.mjs');
  const { paths } = factsFromListFiles([{ filename: 'docs/x.yml', previous_filename: '.github/workflows/tier-check.yml', patch: '@@' }]);
  assert.deepEqual(paths, ['docs/x.yml', '.github/workflows/tier-check.yml']);
  assert.equal(checkR1(paths, config), '.github/workflows/tier-check.yml');
});

// ── e/291 SO C3: inline fallback and checkR1 agree on every entry and near-miss ──────────
test('C3: inlineR1Fallback agrees with the predicate checkR1 on every r1 entry, glob sample and near-miss', async () => {
  const { checkR1 } = await import('./tier-check-predicate.mjs');
  const inline = loadInline();
  const candidates = new Set();
  for (const p of config.r1Paths) {
    for (const v of [p, `${p}.bak`, `x/${p}`, p.toUpperCase(), p.slice(1), `${p}/`]) candidates.add(v);
  }
  for (const g of config.r1Globs ?? []) {
    for (const fill of ['', 'X', 'a/b', '.ps1']) candidates.add(g.split('*').join(fill));
    candidates.add(`x/${g.split('*').join('Y')}`);
  }
  assert.ok(candidates.size > 30, 'the parity set must be substantial');
  for (const p of candidates) {
    const fromPredicate = checkR1([p], config) !== null;
    const fromInline = !inline(files(p), 'Tier: T1', config).pass;
    assert.equal(fromInline, fromPredicate, `parity broken for "${p}": inline=${fromInline} predicate=${fromPredicate}`);
  }
});

// ── t/4343: early visibility into what a declared tier still needs before merge ────────────
const FIXTURE_CHANGE_TIERS_URL = 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/AGENTS.md#change-tiers-and-decision-rights-t4092-pi-approved-2026-10-07';

// t/455: the T1 approval requirement is removed. The note says so, and no longer asks for an approval.
test('tierRequirementsNote: T1 says the approval requirement is removed (t/455), with no approval ask', () => {
  const note = loadTierRequirementsNote()('T1', FIXTURE_CHANGE_TIERS_URL);
  assert.match(note, /t\/455/);
  assert.match(note, /merges on CI and branch protection alone/);
  assert.doesNotMatch(note, /Approved \(<role>\)/);
  assert.doesNotMatch(note, /t1-approval-guard/);
});

test('tierRequirementsNote: T2 names the TL approval path and the PI-only exception, not a bare "PI"', () => {
  const note = loadTierRequirementsNote()('T2', FIXTURE_CHANGE_TIERS_URL);
  assert.match(note, /Second Opinion/);
  assert.match(note, /consult-hold/);
  assert.match(note, /\bTL\b/);
  assert.match(note, /dissents or didn't review/);
  assert.match(note, /PI-only decision/);
  assert.match(note, /consult-hold-guard/);
});

test('both notes render an ABSOLUTE link (not a bare repo-relative AGENTS.md#... that 404s in a PR comment)', () => {
  const t1 = loadTierRequirementsNote()('T1', FIXTURE_CHANGE_TIERS_URL);
  const t2 = loadTierRequirementsNote()('T2', FIXTURE_CHANGE_TIERS_URL);
  for (const note of [t1, t2]) {
    assert.match(note, /https:\/\//, 'the link must be absolute, not repo-relative');
    assert.match(note, /\/blob\/main\/AGENTS\.md#/);
  }
});

test('the call site builds the link from context.serverUrl, not a hardcoded host, and anchors it to blob/main', () => {
  const endIdx = workflow.indexOf('// END requirements-note');
  assert.ok(endIdx >= 0);
  const code = workflow.slice(endIdx, endIdx + 1000);
  assert.match(code, /context\.serverUrl/, 'the URL must come from context.serverUrl, not a hardcoded github.com');
  assert.match(code, /\/blob\/main\/AGENTS\.md#change-tiers-and-decision-rights-t4092-pi-approved-2026-10-07/);
});

test('the Change Tiers heading linked by both notes still exists verbatim in root AGENTS.md', () => {
  const rootAgentsMd = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(rootAgentsMd, /^## Change Tiers and Decision Rights \(t\/4092, PI-approved 2026-10-07\)$/m,
    'the heading the notes link to must still exist verbatim in root AGENTS.md -- a rename here must fail this test, not drift silently');
});

test('CONTROL: tierRequirementsNote returns null for T0 and for an undeclared tier', () => {
  const fn = loadTierRequirementsNote();
  assert.equal(fn('T0'), null);
  assert.equal(fn(null), null);
  assert.equal(fn(undefined), null);
});

// ── t/455 (TL p/9#278): tier-check's comment-filter parity, moved here from
// comment-filter-workflow.test.mjs. That file read the guard's workflow at load and was removed
// with the T1 guard; its tier half is kept here, and its guard half is gone.
//
// The `issue_comment` filter in tier-check.yml must RUN the job for every PR comment body that
// checkR6 reads as evidence (its approval half or its SO half), and for a deleted comment always.
// The REAL predicate is the oracle: every candidate body is fed to checkR6.

const CF_HAYSTACK = "format('{0} {1}', github.event.comment.body, github.event.changes.body.from)";
const CF_PR_GROUP = '${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || github.event.merge_group.head_sha || github.run_id }}';
const CF_RECHECK = '/recheck-guards';
const CF_HEAD = 'c81d7dd8ec596f458dbd199b7e0a697df77ec3dd';
const CF_APP = 'ai-triad-reviewer-jpsnover[bot]';
const CF_PUSH_AT = '2026-10-19T12:00:00Z';
const CF_AFTER_PUSH = '2026-10-19T12:05:00Z';

/** The folded block scalar (`key: >-`) between two marker comment lines, folded to one line. */
function foldedScalar(yml, beginMarker, endMarker, key) {
  const lines = yml.split('\n');
  const begin = lines.findIndex((l) => l.trim() === beginMarker);
  const end = lines.findIndex((l) => l.trim() === endMarker);
  assert.ok(begin >= 0 && end > begin, `markers "${beginMarker}" / "${endMarker}" not found in order`);
  const block = lines.slice(begin + 1, end);
  assert.equal(block[0].trim(), `${key}: >-`, `the line after "${beginMarker}" must be "${key}: >-"`);
  const body = block.slice(1);
  const indents = new Set(body.map((l) => l.length - l.trimStart().length));
  assert.equal(indents.size, 1, `every line of the "${key}" scalar must have the same indentation`);
  return body.map((l) => l.trim()).join(' ');
}

function readFilter(yml) {
  const ifExpr = foldedScalar(yml, '# BEGIN comment-filter', '# END comment-filter', 'if');
  const group = foldedScalar(yml, '# BEGIN comment-filter (group copy)', '# END comment-filter (group copy)', 'group');
  const tokens = [...ifExpr.matchAll(/contains\(format\('\{0\} \{1\}', github\.event\.comment\.body, github\.event\.changes\.body\.from\), '([^']*)'\)/g)].map((m) => m[1]);
  return { ifExpr, group, tokens };
}

/** The exact expression a token list must produce. Pins the whole `if:`, not only its strings. */
function expectedIf(tokens) {
  return [
    '${{',
    '(github.event.issue.pull_request || !github.event.issue)',
    '&& (',
    "github.event_name != 'issue_comment'",
    "|| github.event.action == 'deleted'",
    ...tokens.map((t) => `|| contains(${CF_HAYSTACK}, '${t}')`),
    ')',
    '}}',
  ].join(' ');
}

/** The `if:` as JavaScript. Valid only because expectedIf() pins the expression's shape. */
function jobRuns(tokens, event) {
  const isPrOrNotIssue = Boolean(event.issue?.pull_request) || !event.issue;
  if (!isPrOrNotIssue) return false;
  if (event.eventName !== 'issue_comment') return true;
  if (event.action === 'deleted') return true; // never filtered: the body of a deletion is not relied on
  const haystack = `${event.comment?.body ?? ''} ${event.changes?.body?.from ?? ''}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t.toLowerCase()));
}

const cfPrComment = (body) => ({ eventName: 'issue_comment', issue: { number: 7, pull_request: {} }, comment: { body } });
const cfPrCommentEdit = (body, from) => ({ ...cfPrComment(body), changes: { body: { from } } });

const cfTier = readFilter(workflow);

/** Every `body: '...'` literal in a test file, unescaped; `${CF_HEAD}` filled in. */
function cfHarvestBodies(testFile) {
  const src = readFileSync(path.join(root, 'operations', 'devops', testFile), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  for (const m of src.matchAll(/\bbody:\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g)) {
    let s = m[2].replace(/\$\{HEAD\}/g, CF_HEAD);
    if (s.includes('${')) continue;
    s = s.replace(/\\(n|t|[\s\S])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    out.push(s);
  }
  return out;
}

/** True when checkR6 reads this comment body as evidence: the approval half or the SO half. */
function tierReacts(body) {
  const c = { body, createdAt: CF_AFTER_PUSH };
  const soHalf = { body: 'SO did not review within the time-box.', createdAt: CF_AFTER_PUSH };
  const approvalHalf = { body: 'Approved (PI): go ahead.', createdAt: CF_AFTER_PUSH };
  const asApproval = !checkR6(true, [], [soHalf, c], [], CF_HEAD, CF_APP, CF_PUSH_AT);
  const asSo = !checkR6(true, [], [approvalHalf, c], [], CF_HEAD, CF_APP, CF_PUSH_AT);
  return asApproval || asSo;
}

function tierVariants() {
  return [
    'Approved (PI): go ahead.', 'Some context first.\nApproved (PI): proceeding.', 'Approved (PI):',
    'SO did not review within the time-box.', 'so DID NOT review this one', 'Marked: SO did not review',
    `**SO clearing comment (T2, t/4266), head \`${CF_HEAD}\`.**`, `so clearing comment ${CF_HEAD}`, `Note.\nSO clearing comment, head ${CF_HEAD}`,
  ];
}

const CF_CHATTER = [
  'Head updated to abc123',
  'Head updated to 65ab11a02585bcadd6e76dad463ebfbde285d291. Rebased onto main, no content change.',
  'Ready for reviewer approval',
  'CI has been green for 37 min',
  'Pushed a fix for the lint failure; waiting on ci-gate.',
  'Enqueued pinned at the current head.',
  '',
];

test('tier-check.yml: the if: is exactly the PR-comment condition AND (not issue_comment OR a listed substring)', () => {
  assert.ok(cfTier.tokens.length > 0, 'no filter substrings found');
  assert.equal(cfTier.ifExpr, expectedIf(cfTier.tokens));
  for (const t of cfTier.tokens) assert.ok(t.length >= 8, `"${t}" is too short to be distinctive`);
});

test('tier-check.yml: the concurrency group carries the SAME filter, so a skipped run never shares the PR\'s group', () => {
  const inner = cfTier.ifExpr.replace(/^\$\{\{ /, '').replace(/ \}\}$/, '');
  assert.equal(cfTier.group, `${CF_PR_GROUP}-\${{ ( ${inner} ) && 'evaluate' || github.run_id }}`);
});

test('tier-check.yml: the explicit re-run token runs the job, and the header and docs/pr-landing.md name it', () => {
  assert.ok(cfTier.tokens.includes(CF_RECHECK));
  assert.equal(jobRuns(cfTier.tokens, cfPrComment(CF_RECHECK)), true);
  assert.equal(jobRuns(cfTier.tokens, cfPrComment(`Dismissed the stale review.\n\n${CF_RECHECK}\n`)), true);
  assert.match(workflow.slice(0, workflow.indexOf('\non:\n')), /\/recheck-guards/, 'the workflow header must document the token');
  assert.match(readFileSync(path.join(root, 'docs', 'pr-landing.md'), 'utf8'), /\/recheck-guards/);
});

test('tier-check.yml: status chatter does not run the job', () => {
  for (const body of CF_CHATTER) assert.equal(jobRuns(cfTier.tokens, cfPrComment(body)), false, `chatter ran the job: ${JSON.stringify(body)}`);
});

test('tier-check.yml: every other trigger still runs, and a comment on a plain issue never does', () => {
  assert.equal(jobRuns(cfTier.tokens, { eventName: 'pull_request_target' }), true);
  assert.equal(jobRuns(cfTier.tokens, { eventName: 'pull_request_review' }), true);
  const plainIssue = { eventName: 'issue_comment', issue: { number: 7 }, comment: { body: `Approved (PI): x ${CF_RECHECK}` } };
  assert.equal(jobRuns(cfTier.tokens, plainIssue), false);
});

test('tier-check.yml: an edit runs the job when EITHER the new or the previous body matches', () => {
  const verdict = 'Approved (PI): go ahead.';
  assert.equal(jobRuns(cfTier.tokens, cfPrCommentEdit(verdict, 'Looking now.')), true, 'edited INTO evidence');
  assert.equal(jobRuns(cfTier.tokens, cfPrCommentEdit('Withdrawn, see below.', verdict)), true, 'evidence edited AWAY must re-evaluate');
  assert.equal(jobRuns(cfTier.tokens, cfPrCommentEdit('Head updated to abc124', 'Head updated to abc123')), false, 'chatter edited into chatter');
});

test('tier-check.yml: a deleted or edited comment and a dismissed review are triggers', () => {
  const types = (event) => {
    const m = new RegExp(`^  ${event}:\\n(?:    branches: .*\\n)?    types: \\[([^\\]]*)\\]`, 'm').exec(workflow.slice(workflow.indexOf('\non:\n')));
    assert.ok(m, `no inline types list for ${event}`);
    return m[1].split(',').map((s) => s.trim());
  };
  assert.deepEqual(types('issue_comment'), ['created', 'edited', 'deleted']);
  assert.deepEqual(types('pull_request_review'), ['submitted', 'dismissed']);
});

test('tier-check: every body R6 reads as evidence runs the job (its own test fixtures + variants)', () => {
  const candidates = [...cfHarvestBodies('tier-check-predicate.test.mjs'), ...tierVariants()];
  const reacting = candidates.filter(tierReacts);
  assert.ok(reacting.length >= 12, `too few reacting candidates to mean anything (${reacting.length} of ${candidates.length})`);
  for (const body of reacting) {
    assert.equal(jobRuns(cfTier.tokens, cfPrComment(body)), true, `R6 reads this as evidence, but the filter would skip it: ${JSON.stringify(body)}`);
  }
});

test('tier-check: the oracle is live -- each kind of R6 comment evidence reacts, chatter does not', () => {
  assert.equal(tierReacts('Approved (PI): go ahead.'), true);
  assert.equal(tierReacts('SO did not review within the time-box.'), true);
  assert.equal(tierReacts(`**SO clearing comment, head \`${CF_HEAD}\`.**`), true);
  assert.equal(tierReacts('Approved (Quality): fine'), false, 'a role approval comment is not R6 evidence');
  assert.equal(tierReacts('Head updated to abc123'), false);
});

test('tier-check: comment bodies are read ONLY by checkR6 -- a new reader must extend the filter', () => {
  const predicate = readFileSync(path.join(root, 'operations', 'devops', 'tier-check-predicate.mjs'), 'utf8');
  const code = predicate.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  for (const re of ['PI_COMMENT_APPROVAL_RE', 'SO_DID_NOT_REVIEW_RE', 'SO_CLEARING_PREFIX_RE']) {
    assert.match(code, new RegExp(`const ${re} = `));
  }
  const usesOfComments = [...code.matchAll(/\bapprovalComments\b/g)].length;
  assert.equal(usesOfComments, 2, 'approvalComments must appear exactly twice in evaluateTierCheck: destructured, then passed to checkR6');
  assert.match(code, /checkR6\(tier === 'T2' \|\| Boolean\(r1\), labels, approvalComments \?\? \[\]/);
});
