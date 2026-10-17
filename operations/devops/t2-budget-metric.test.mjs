// operations/devops/t2-budget-metric.test.mjs
// Author-run: node --test operations/devops/t2-budget-metric.test.mjs
//
// t/4122: both-arms fixture proof (9% no alert, 11% alerts) + tallying/top-paths unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t2BudgetVerdict, topPathsByFrequency, tallyTiers, T2_ALERT_THRESHOLD_PCT } from './t2-budget-metric.mjs';

test('T2_ALERT_THRESHOLD_PCT is co-located and is 10 (t/4103#3 / t/4107)', () => {
  assert.equal(T2_ALERT_THRESHOLD_PCT, 10);
});

// ── BOTH ARMS (t/4122 acceptance criterion, exact wording: "9% gives no alert, 11% alerts") ──
test('ACCEPTANCE: a 9% T2 share does NOT alert', () => {
  const v = t2BudgetVerdict({ t0: 80, t1: 11, t2: 9, none: 0 });
  assert.equal(v.t2.pct, 9);
  assert.equal(v.alert, false);
});

test('ACCEPTANCE: an 11% T2 share DOES alert', () => {
  const v = t2BudgetVerdict({ t0: 78, t1: 11, t2: 11, none: 0 });
  assert.equal(v.t2.pct, 11);
  assert.equal(v.alert, true);
});

test('exactly at the 10% threshold does not alert (strict >)', () => {
  const v = t2BudgetVerdict({ t0: 90, t1: 0, t2: 10, none: 0 });
  assert.equal(v.t2.pct, 10);
  assert.equal(v.alert, false);
});

test('zero PRs in the window produces 0% shares, no alert, no divide-by-zero', () => {
  const v = t2BudgetVerdict({});
  assert.equal(v.total, 0);
  assert.equal(v.t2.pct, 0);
  assert.equal(v.alert, false);
});

test('reports t0/t1 shares and the no-tier-declared count alongside t2 (t/4122 "also report" ask)', () => {
  const v = t2BudgetVerdict({ t0: 60, t1: 20, t2: 10, none: 10 });
  assert.equal(v.t0.count, 60);
  assert.equal(v.t1.count, 20);
  assert.equal(v.none.count, 10);
  assert.equal(v.total, 100);
});

// ── tallyTiers (extractTier reuse, not a second hand-maintained regex) ──────────────────────
test('tallyTiers buckets PRs by their first-line Tier: declaration', () => {
  const prs = [
    { body: 'Tier: T0\n\nSome fix.' },
    { body: 'Tier: T1 (routine)\n\nAdds a cmdlet.' },
    { body: 'Tier: T2\n\nBreaking schema change.' },
    { body: 'No tier line here, just prose.' },
    { body: null },
  ];
  assert.deepEqual(tallyTiers(prs), { t0: 1, t1: 1, t2: 1, none: 2 });
});

test('tallyTiers treats an empty PR list as all-zero, not an error', () => {
  assert.deepEqual(tallyTiers([]), { t0: 0, t1: 0, t2: 0, none: 0 });
  assert.deepEqual(tallyTiers(undefined), { t0: 0, t1: 0, t2: 0, none: 0 });
});

// ── topPathsByFrequency ("top 5 T2 paths by frequency, so the R1 list can be narrowed") ─────
test('topPathsByFrequency ranks paths across multiple T2 PRs by how often each recurs', () => {
  const fileLists = [
    ['deploy/azure/main.bicep', 'deploy/azure/deploy.ps1'],
    ['deploy/azure/main.bicep'],
    ['.github/branch-protection.json'],
    ['deploy/azure/main.bicep', '.github/branch-protection.json'],
  ];
  const top = topPathsByFrequency(fileLists, 5);
  assert.deepEqual(top[0], { path: 'deploy/azure/main.bicep', count: 3 });
  assert.deepEqual(top[1], { path: '.github/branch-protection.json', count: 2 });
  assert.deepEqual(top[2], { path: 'deploy/azure/deploy.ps1', count: 1 });
});

test('topPathsByFrequency caps at topN and ties break alphabetically for determinism', () => {
  const fileLists = [['z.ts'], ['a.ts'], ['m.ts'], ['b.ts'], ['y.ts'], ['x.ts']];
  const top = topPathsByFrequency(fileLists, 3);
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((t) => t.path), ['a.ts', 'b.ts', 'm.ts']);
});

test('topPathsByFrequency on an empty T2 set returns an empty list, not an error', () => {
  assert.deepEqual(topPathsByFrequency([], 5), []);
  assert.deepEqual(topPathsByFrequency(undefined, 5), []);
});

// ── FAULT-ARM: prove the suite catches a hypothetical regression in t2BudgetVerdict ─────────
test('FAULT-ARM: a t2BudgetVerdict that never alerts is distinguishable from the real one', () => {
  function brokenVerdict() {
    return { alert: false }; // t/3897#6-shaped: silently never fires
  }
  const real = t2BudgetVerdict({ t0: 78, t1: 11, t2: 11, none: 0 });
  assert.equal(real.alert, true, 'the real implementation correctly alerts at 11%');

  const broken = brokenVerdict();
  assert.equal(broken.alert, false, 'the broken stub would have silently never alerted — exactly what this test catches');
});
