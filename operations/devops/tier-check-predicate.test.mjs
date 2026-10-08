import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTier,
  extractSchemaChange,
  isDependabot,
  checkR1,
  checkR2a,
  checkR2b,
  checkR2c,
  checkR3,
  checkR4,
  checkR5,
  evaluateTierCheck,
} from './tier-check-predicate.mjs';

const CONFIG = {
  r1Paths: ['.github/ci/required-contexts.json', '.github/workflows/tier-check.yml'],
  r1Globs: ['operations/devops/Move-PiCredential*.ps1'],
  r2cGlobs: ['**/eslint.config.mjs', '**/PSScriptAnalyzerSettings.psd1'],
  schemaDirPrefixes: ['lib/schema/', 'taxonomy/schemas/'],
};

// ── tier line / schema line / dependabot ────────────────────────────────────
test('extractTier: matches with and without trailing text, rejects wrong position', () => {
  assert.equal(extractTier('Tier: T2\n\nbody'), 'T2');
  assert.equal(extractTier('Tier: T0 (auth/secrets)\n\nbody'), 'T0');
  assert.equal(extractTier('some other first line\nTier: T1'), null);
  assert.equal(extractTier(''), null);
  assert.equal(extractTier(null), null);
});

test('extractSchemaChange: additive and breaking, missing is null', () => {
  assert.equal(extractSchemaChange('Tier: T1\n\nSchema-change: additive\n'), 'additive');
  assert.equal(extractSchemaChange('Tier: T2\n\nSchema-change: breaking\n'), 'breaking');
  assert.equal(extractSchemaChange('Tier: T1\n\nno such line'), null);
});

test('isDependabot', () => {
  assert.equal(isDependabot('dependabot/npm_and_yarn/foo-1.2.3'), true);
  assert.equal(isDependabot('feat/t4103-tier-check'), false);
});

// ── R1 ───────────────────────────────────────────────────────────────────
test('R1: exact-path and glob hits found; non-R1 paths return null', () => {
  assert.equal(checkR1(['.github/ci/required-contexts.json'], CONFIG), '.github/ci/required-contexts.json');
  assert.equal(checkR1(['operations/devops/Move-PiCredential-ToVault.ps1'], CONFIG), 'operations/devops/Move-PiCredential-ToVault.ps1');
  assert.equal(checkR1(['lib/debate/aiAdapter.ts'], CONFIG), null);
});

// ── R2a ──────────────────────────────────────────────────────────────────
test('R2a: removing continue-on-error: true fires; adding it does not', () => {
  const removed = [{ path: '.github/workflows/tier-check.yml', removedLines: ['      continue-on-error: true'] }];
  assert.equal(checkR2a(removed), '.github/workflows/tier-check.yml');
  const added = [{ path: '.github/workflows/tier-check.yml', removedLines: [] }];
  assert.equal(checkR2a(added), null);
});

// ── R2b ──────────────────────────────────────────────────────────────────
test('R2b: an added ci-gate needs entry fires; a removed entry does not', () => {
  assert.deepEqual(checkR2b(['a', 'b'], ['a', 'b', 'c']), ['c']);
  assert.equal(checkR2b(['a', 'b', 'c'], ['a', 'b']), null);
  assert.equal(checkR2b(['a', 'b'], ['a', 'b']), null);
});

// ── R2c (includes the real #2903 fixture) ─────────────────────────────────
test('R2c: #2903 real fixture — complexity-budget raised to error via a module-level const — fires', () => {
  const addedLines = [
    "+const COMPLEXITY_BUDGET = ['error', { baseline: 'eslint-rules/lib-complexity-baseline.json', threshold: 15 }];",
    "+      'local/complexity-budget': COMPLEXITY_BUDGET,",
  ].map((l) => l.slice(1));
  const removedLines = [
    "-      'complexity': ['warn', { max: 15 }],",
  ].map((l) => l.slice(1));
  const hits = checkR2c([{ path: 'lib/eslint.config.mjs', addedLines, removedLines }], CONFIG);
  assert.ok(hits);
  assert.equal(hits.length, 1);
  assert.match(hits[0].line, /COMPLEXITY_BUDGET/);
});

test('R2c: moving/reformatting an existing error rule for the SAME key does not fire', () => {
  const addedLines = ["      'local/require-windows-hide': 'error',"];
  const removedLines = ["   'local/require-windows-hide': 'error',"];
  assert.equal(checkR2c([{ path: 'lib/eslint.config.mjs', addedLines, removedLines }], CONFIG), null);
});

test('R2c: PSScriptAnalyzerSettings Severity including Error fires', () => {
  const addedLines = ["    Severity = @('Error')"];
  const hits = checkR2c([{ path: 'scripts/PSScriptAnalyzerSettings.psd1', addedLines, removedLines: [] }], CONFIG);
  assert.ok(hits);
});

test('R2c: a new rule added at warn stays T0 (no fire)', () => {
  const addedLines = ["      'local/new-rule': 'warn',"];
  assert.equal(checkR2c([{ path: 'lib/eslint.config.mjs', addedLines, removedLines: [] }], CONFIG), null);
});

test('R2c: #2790 real fixture — a comment line mentioning "error" is NOT flagged', () => {
  const addedLines = [
    '      // Flashing-console prevention (t/3914, t/3922): child_process calls need windowsHide: true.',
    "      // Warn-first; promotion to 'error' is a new blocking gate and needs a Second Opinion.",
    "      'local/require-windows-hide': 'warn',",
  ];
  assert.equal(checkR2c([{ path: 'lib/eslint.config.mjs', addedLines, removedLines: [] }], CONFIG), null);
});

test('R2c: the #2903 const fixture still fires after the comment-skip change', () => {
  const addedLines = [
    "const COMPLEXITY_BUDGET = ['error', { baseline: 'eslint-rules/lib-complexity-baseline.json', threshold: 15 }];",
    "      'local/complexity-budget': COMPLEXITY_BUDGET,",
  ];
  const removedLines = ["      'complexity': ['warn', { max: 15 }],"];
  const hits = checkR2c([{ path: 'lib/eslint.config.mjs', addedLines, removedLines }], CONFIG);
  assert.ok(hits);
  assert.equal(hits.length, 1);
});

// ── R3 ───────────────────────────────────────────────────────────────────
test('R3: additive with no tier requirement; missing line; breaking without T2 fails; breaking with T2 passes', () => {
  assert.equal(checkR3(['lib/schema/foo.json'], 'additive', 'T1', CONFIG), null);
  assert.deepEqual(checkR3(['lib/schema/foo.json'], null, 'T1', CONFIG), { kind: 'missing_line', path: 'lib/schema/foo.json' });
  assert.deepEqual(checkR3(['lib/schema/foo.json'], 'breaking', 'T1', CONFIG), { kind: 'breaking_no_t2', path: 'lib/schema/foo.json' });
  assert.equal(checkR3(['lib/schema/foo.json'], 'breaking', 'T2', CONFIG), null);
  assert.equal(checkR3(['lib/debate/foo.ts'], null, null, CONFIG), null);
});

test('R3: a test file in a schema dir is NOT flagged (real #3075/#3018/#2946/#2933 pattern); a real schema file still is', () => {
  assert.equal(checkR3(['lib/schema/povTagProposals.test.ts'], null, 'T1', CONFIG), null);
  assert.equal(checkR3(['lib/schema/pov-tags-cli.closure.test.ts'], null, 'T1', CONFIG), null);
  assert.equal(checkR3(['lib/schema/__tests__/foo.ts'], null, 'T1', CONFIG), null);
  assert.deepEqual(checkR3(['lib/schema/povTagProposals.ts'], null, 'T1', CONFIG), { kind: 'missing_line', path: 'lib/schema/povTagProposals.ts' });
});

// ── R4 ───────────────────────────────────────────────────────────────────
test('R4: missing tier line fails only after the grace cutoff; dependabot is exempt', () => {
  const cutoff = new Date('2026-10-08T00:00:00Z');
  assert.equal(checkR4(null, false, new Date('2026-10-07T00:00:00Z'), cutoff), false);
  assert.equal(checkR4(null, false, new Date('2026-10-09T00:00:00Z'), cutoff), true);
  assert.equal(checkR4(null, true, new Date('2026-10-09T00:00:00Z'), cutoff), false);
  assert.equal(checkR4('T0', false, new Date('2026-10-09T00:00:00Z'), cutoff), false);
});

// ── R5 ───────────────────────────────────────────────────────────────────
test('R5: declared T2 without consult-hold is advisory-flagged; T2 with the label is not; non-T2 is never flagged', () => {
  assert.equal(checkR5('T2', []), true);
  assert.equal(checkR5('T2', ['consult-hold']), false);
  assert.equal(checkR5('T1', []), false);
});

// ── evaluateTierCheck: full integration, R5 never affects pass/fail ───────
test('evaluateTierCheck: R1 hit without T2 fails; R5 alone never flips pass to false', () => {
  const base = {
    body: 'Tier: T1\n\nsome body',
    headRefName: 'feat/x',
    paths: ['.github/ci/required-contexts.json'],
    prCreatedAt: new Date('2026-10-09T00:00:00Z'),
    graceCutoff: new Date('2026-10-08T00:00:00Z'),
    labels: [],
    config: CONFIG,
    workflowDiffs: [],
    lintDiffs: [],
    baseCiGateNeeds: null,
    headCiGateNeeds: null,
  };
  const result = evaluateTierCheck(base);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.rule === 'R1'));

  const t2WithoutHold = evaluateTierCheck({ ...base, body: 'Tier: T2\n\nsome body' });
  assert.equal(t2WithoutHold.pass, true);
  assert.equal(t2WithoutHold.r5Advisory, true);
});

test('evaluateTierCheck: a clean T0 PR with no rule hits passes with no comments', () => {
  const result = evaluateTierCheck({
    body: 'Tier: T0\n\nfix a typo',
    headRefName: 'fix/typo',
    paths: ['README.md'],
    prCreatedAt: new Date('2026-10-09T00:00:00Z'),
    graceCutoff: new Date('2026-10-08T00:00:00Z'),
    labels: [],
    config: CONFIG,
    workflowDiffs: [],
    lintDiffs: [],
    baseCiGateNeeds: null,
    headCiGateNeeds: null,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.comments, []);
});
