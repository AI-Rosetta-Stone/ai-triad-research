// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Cases for the T0 rule-order test (t/73, Second Opinion's condition 4 on #4795).
//
// WHY: #4795 moved selectT0Candidates' per-PR skip rules into sharedSkipReason, and passes the
// t/309 re-pin re-check in as an `afterConflict` callback. Whether the rules still run in the same
// order is proven by running the SAME inputs through main's selectT0Candidates and the refactored
// one and comparing the outputs, not by reading the code.
//
// HOW: one PR that passes every rule (BASE), and a list of MUTATORS that each trip exactly one
// rule. The cases are BASE, every mutator alone, and every PAIR of mutators applied together. A
// pair is what shows the order: with two rules tripped, the reported reason is the rule that runs
// first. Mutators are applied in list order and edit only the fields their rule reads, so two of
// them compose (labels are appended, contexts are mapped, reviews are appended).
//
// This file imports nothing from the sweep, so the same cases can be run against any copy of
// t0-enqueue-sweep.mjs (gen-t0-rule-order-fixture.mjs runs them against main's).

export const NOW_MS = Date.parse('2026-11-02T12:00:00Z');
const minsAgo = (m) => new Date(NOW_MS - m * 60000).toISOString();

const REQUIRED = ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard'];
const REVIEWER = 'ai-triad-reviewer-jpsnover'; // GraphQL author.login, as the sweep reads it
const HEAD = 'abc1234abc1234abc1234abc1234abc1234abc12';
const RENDERER_FILE = 'taxonomy-editor/src/renderer/components/x/Thing.tsx';
const NON_UI_FILE = 'operations/devops/enqueue-pr.mjs';
const REPIN_BRANCH = 'docker/base-repin-2026-11-10-bbbbbbb';
const REPIN_T1 = { tier: 'T1', reason: 'line count changed (6 -> 7)' };

/** A same-repo T0 PR that passes every rule: green, pushed 20 minutes ago, nothing blocking. */
export function basePr() {
  return {
    number: 1, body: 'Tier: T0\n\nFix a thing.', headRefOid: HEAD, headRefName: 'devops/t1-fix-a-thing',
    baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED',
    author: 'ai-triad-author-jpsnover', labels: [], isCrossRepository: false, autoMergeRequest: null,
    reviewDataError: false, files: [NON_UI_FILE], reviews: [], comments: [], queueEvents: [],
    contexts: REQUIRED.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: minsAgo(20) })),
  };
}

const mapContext = (pr, name, fn) => ({ ...pr, contexts: pr.contexts.map((c) => (c.name === name ? fn(c) : c)) });
const failed = (name) => (pr) => mapContext(pr, name, (c) => ({ ...c, conclusion: 'FAILURE' }));
const addLabel = (label) => (pr) => ({ ...pr, labels: [...pr.labels, label] });
const addReview = (body) => (pr) => ({
  ...pr, reviews: [...pr.reviews, { body, login: REVIEWER, commitId: pr.headRefOid, submittedAt: minsAgo(10) }],
});

/**
 * `id` names the case, `rule` is the rule it trips (main's order, top to bottom), `wins` matches
 * the skip reason when this mutator is applied alone, and `apply` returns the mutated PR.
 */
export const MUTATORS = [
  { id: 'fork', rule: 'fork', wins: /^fork PR/, apply: (pr) => ({ ...pr, isCrossRepository: true }) },
  { id: 'fork-unknown', rule: 'fork', wins: /^fork PR/, apply: (pr) => ({ ...pr, isCrossRepository: undefined }) },
  { id: 'not-t0', rule: 'not declared T0', wins: /^not declared Tier: T0$/, apply: (pr) => ({ ...pr, body: 'Tier: T1\n\nFix a thing.' }) },
  { id: 'base-not-main', rule: 'base not main', wins: /^base is epic\/x, not main$/, apply: (pr) => ({ ...pr, baseRefName: 'epic/x' }) },
  { id: 'draft', rule: 'draft', wins: /^draft$/, apply: (pr) => ({ ...pr, isDraft: true }) },
  { id: 'queued', rule: 'already queued', wins: /^already in merge queue$/, apply: (pr) => ({ ...pr, isInMergeQueue: true }) },
  { id: 'dependabot', rule: 'Dependabot', wins: /^Dependabot PR/, apply: (pr) => ({ ...pr, author: 'app/dependabot' }) },
  { id: 'label-consult-hold', rule: 'blocking label', wins: /^label consult-hold$/, apply: addLabel('consult-hold') },
  { id: 'label-joint-gv', rule: 'blocking label', wins: /^label joint-gv$/, apply: addLabel('joint-gv') },
  { id: 'label-no-auto-enqueue', rule: 'blocking label', wins: /^label no-auto-enqueue$/, apply: addLabel('no-auto-enqueue') },
  {
    // Enqueued 18m ago and pulled out by hand 16m ago; the head was pushed 20m ago.
    id: 'manual-dequeue', rule: 'manual-dequeue hold', wins: /^WARN: manually dequeued by jpsnover/,
    apply: (pr) => ({
      ...pr,
      queueEvents: [
        { type: 'AddedToMergeQueueEvent', createdAt: minsAgo(18), reason: null, actor: 'jpsnover' },
        { type: 'RemovedFromMergeQueueEvent', createdAt: minsAgo(16), reason: 'manual', actor: 'jpsnover' },
      ],
    }),
  },
  { id: 'conflict', rule: 'merge conflict', wins: /^merge conflict$/, apply: (pr) => ({ ...pr, mergeStateStatus: 'DIRTY' }) },
  {
    id: 'repin-not-pure', rule: 're-pin re-check', wins: /^WARN: docker\/base-repin-.* head is not a pure base-pin bump \(line count changed/,
    apply: (pr) => ({ ...pr, headRefName: REPIN_BRANCH, repinCheck: { ...REPIN_T1 } }),
  },
  {
    id: 'repin-facts-missing', rule: 're-pin re-check', wins: /^WARN: docker\/base-repin-.* head could not be re-classified/,
    apply: (pr) => {
      const { repinCheck: _dropped, ...rest } = pr;
      return { ...rest, headRefName: REPIN_BRANCH };
    },
  },
  { id: 'review-data-error', rule: 'review data error', wins: /^WARN: could not fetch files\/reviews\/comments/, apply: (pr) => ({ ...pr, reviewDataError: true }) },
  { id: 'changes-requested', rule: 'changes requested', wins: /^changes requested by Quality$/, apply: addReview('Changes requested (Quality): fix the error path.') },
  {
    id: 'changes-requested-unparsed', rule: 'changes requested', wins: /^WARN: changes requested by \(unparseable\) \(unparsed reviewer-App body/,
    apply: addReview('changes requested, will write up the specifics shortly'),
  },
  {
    // A comment is not bound to a head: it counts because it was posted after the push.
    id: 'changes-requested-comment', rule: 'changes requested', wins: /^changes requested by Design$/,
    apply: (pr) => ({
      ...pr, comments: [...pr.comments, { body: 'Changes requested (Design): the empty state is unreadable.', login: REVIEWER, createdAt: minsAgo(10), updatedAt: null }],
    }),
  },
  { id: 'design-gate', rule: 'Design gate', wins: /^awaiting Design gate$/, apply: (pr) => ({ ...pr, files: [...pr.files, RENDERER_FILE] }) },
  { id: 'ci-gate-failed', rule: 'required context', wins: /^ci-gate is failed$/, apply: failed('ci-gate') },
  { id: 'codeql-failed', rule: 'required context', wins: /^CodeQL Analysis is failed$/, apply: failed('CodeQL Analysis') },
  { id: 'joint-gv-guard-failed', rule: 'required context', wins: /^joint-gv-guard is failed$/, apply: failed('joint-gv-guard') },
  { id: 'consult-hold-guard-failed', rule: 'required context', wins: /^consult-hold-guard is failed$/, apply: failed('consult-hold-guard') },
  {
    id: 'codeql-missing', rule: 'required context', wins: /^CodeQL Analysis is missing$/,
    apply: (pr) => ({ ...pr, contexts: pr.contexts.filter((c) => c.name !== 'CodeQL Analysis') }),
  },
  {
    id: 'joint-gv-guard-pending', rule: 'required context', wins: /^joint-gv-guard is pending$/,
    apply: (pr) => mapContext(pr, 'joint-gv-guard', (c) => ({ ...c, status: 'IN_PROGRESS', conclusion: null })),
  },
  {
    id: 'check-running', rule: 'checks still running', wins: /^1 check\(s\) still running \(Stray File Guard\)$/,
    apply: (pr) => ({ ...pr, contexts: [...pr.contexts, { name: 'Stray File Guard', status: 'IN_PROGRESS', conclusion: null }] }),
  },
  {
    // Paired with `idle` this still wins: `idle` only moves a start time that exists.
    id: 'push-time-unknown', rule: 'push time unknown', wins: /^push time unknown/,
    apply: (pr) => ({ ...pr, contexts: pr.contexts.map(({ startedAt: _dropped, ...c }) => c) }),
  },
  {
    id: 'idle', rule: 'idle window', wins: /^idle 5m < 15m since last push$/,
    apply: (pr) => ({ ...pr, contexts: pr.contexts.map((c) => ('startedAt' in c ? { ...c, startedAt: minsAgo(5) } : c)) }),
  },
];

/** Every case: BASE, each mutator alone, and each pair (list order). `{ id, mutators, pr }`. */
export function buildCases() {
  const cases = [{ id: 'base', mutators: [], pr: basePr() }];
  for (const m of MUTATORS) cases.push({ id: m.id, mutators: [m.id], pr: m.apply(basePr()) });
  for (let i = 0; i < MUTATORS.length; i++) {
    for (let j = i + 1; j < MUTATORS.length; j++) {
      const a = MUTATORS[i];
      const b = MUTATORS[j];
      cases.push({ id: `${a.id}+${b.id}`, mutators: [a.id, b.id], pr: b.apply(a.apply(basePr())) });
    }
  }
  // A distinct PR number per case, so a batch run can be matched back to its case.
  cases.forEach((c, i) => { c.pr = { ...c.pr, number: 1000 + i }; });
  return cases;
}

export const EXPECTED_CASE_COUNT = 1 + MUTATORS.length + (MUTATORS.length * (MUTATORS.length - 1)) / 2;

/**
 * What selectT0Candidates decided for one PR, in a plain shape that survives JSON: whether it was
 * enqueued (and the entry), the full skip reason, the re-pin comment request if any, and the
 * idle-window wait if any. Throws if the PR is in neither list or in both.
 */
export function recordOutcome(id, number, { enqueue, skip, waiting }) {
  const e = enqueue.filter((x) => x.number === number);
  const s = skip.filter((x) => x.number === number);
  const w = waiting.filter((x) => x.number === number);
  if (e.length + s.length !== 1 || w.length > 1) {
    throw new Error(
      `t0-rule-order: case ${id} (#${number}) is in ${e.length} enqueue, ${s.length} skip and ${w.length} waiting entries.\n` +
      '  Goal:       record one decision per case.\n' +
      '  Problem:    selectT0Candidates must put a PR in exactly one of enqueue or skip.\n' +
      '  Location:   operations/devops/t0-rule-order.cases.mjs (recordOutcome).\n' +
      '  Next steps: run the case by hand and read selectT0Candidates in t0-enqueue-sweep.mjs.',
    );
  }
  const extraSkipKeys = s.length ? Object.keys(s[0]).filter((k) => !['number', 'reason', 'repinComment'].includes(k)).sort() : [];
  return {
    id,
    enqueued: e.length === 1,
    enqueueEntry: e[0] ?? null,
    reason: s[0]?.reason ?? null,
    repinComment: s[0]?.repinComment ?? null,
    extraSkipKeys,
    waiting: w.length ? { eligibleAt: w[0].eligibleAt } : null,
  };
}

/** Runs every case through `selectT0Candidates`, ONE PR per call. Returns the outcome records. */
export function runCases(selectT0Candidates) {
  return buildCases().map((c) => recordOutcome(c.id, c.pr.number, selectT0Candidates([c.pr], NOW_MS)));
}

/** The same cases in ONE call, to show no state leaks from one PR to the next. */
export function runCasesInOneBatch(selectT0Candidates) {
  const cases = buildCases();
  const out = selectT0Candidates(cases.map((c) => c.pr), NOW_MS);
  return cases.map((c) => recordOutcome(c.id, c.pr.number, out));
}
