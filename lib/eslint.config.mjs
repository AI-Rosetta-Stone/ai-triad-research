// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ESLint flat config for @ai-triad/lib.
//
// Two concerns:
//  1. Async safety — fire-and-forget promises and async/sync callback mismatches
//     (type-aware; needs projectService). No style/formatting rules — Prettier owns that.
//  2. File-size budget (ADR-007) — max-lines anti-regression gate. ESLint is the
//     single source of truth for .ts/.tsx LOC across first-party packages
//     (check-quality-gates.sh is being narrowed to byte/css/tsc guards — DevOps t/1692).
//     Thresholds: non-test source 1500, test source 2000, both counting blank + comment
//     lines (skipBlankLines/skipComments:false) for one stable number. Existing offenders
//     are baselined below and the baseline shrinks monotonically to zero as the Phase-2
//     split tickets under epic t/1681 land under budget.

import tseslint from 'typescript-eslint';
import noActionableErrorMessageNesting from './eslint-rules/no-actionable-error-message-nesting.js';
import requireWarnOnDegradedCatchReturn from './eslint-rules/require-warn-on-degraded-catch-return.js';
import requireWindowsHide from './eslint-rules/require-windows-hide.js';
import requireWindowsHideDisableReason from './eslint-rules/require-windows-hide-disable-reason.js';
import complexityBudget from './eslint-rules/complexity-budget.js';
import noBareThrow from './eslint-rules/no-bare-throw.js';

// ── Complexity ratchet (t/3823 Phase 2; rule + generator from t/3821) ──────────────────────────────
// GATE CO-LOCATION: the gate is `local/complexity-budget` at 'error' in Blocks A and A-tsx below; lib
// CI runs `pnpm run lint` from lib/ and gates on errors (ci.yml), so this is CI-enforced with no
// workflow change. `complexity` itself stays at 'warn' (advisory measurement, not the gate).
//  - BASELINE: lib's OWN file, eslint-rules/lib-complexity-baseline.json, never taxonomy-editor's: two
//    configs sharing one baseline with one __meta__.threshold is the t/3838 vector (TL t/3823#1).
//  - OFFENDERS ONLY (max > 15), .ts/.tsx only, keys relative to lib/ (ESLint runs here; the rule
//    resolves paths against context.cwd). Regenerate (write-only-downward; never raises a number):
//      node eslint-rules/generate-complexity-baseline.mjs --root . --ext ts,tsx \
//        --baseline eslint-rules/lib-complexity-baseline.json --scope-note "<keep the existing note>"
//    --ext makes the baseline, its self-assertion and --drift-check all count exactly the gated files.
//  - SCOPE BLANK, named (TL t/3823#9; also in the baseline's __meta__.scope_note): lib/**/*.js and
//    *.mjs, including the 3 eslint-rules/*.js rule files, are OUTSIDE the gate. lib has no .js lint
//    block, deliberately, for now. Tests are excluded by design.
//  - RAISE PATH (SO e/286#2 C5): when a real change must make a file more complex (e.g. a bug fix that
//    adds one branch to runTurn.ts), RAISE ITS BASELINE ENTRY BY HAND, in its own commit, with a one-line
//    justification in the PR body ("raise <file> max A->B: <why>"). It is reviewed as T1. The generator
//    never raises a number, so a hand edit is the only way up, and it is meant to be visible and cheap.
//  - NO INLINE BYPASS (SO e/286#2 C2): an eslint-disable naming local/complexity-budget, a blanket
//    eslint-disable, or an inline `eslint local/complexity-budget: off` FAILS lint. `pnpm run lint` runs
//    eslint-rules/check-complexity-budget-disables.mjs after eslint, as a separate process so no source
//    comment can switch it off. Use the raise path above instead.
const COMPLEXITY_BUDGET = ['error', { baseline: 'eslint-rules/lib-complexity-baseline.json', threshold: 15 }];
// Bare-throw ratchet (t/4153, root rule #19): warn-first against a baseline shared with taxonomy-editor's
// server config. Promoting it to 'error' is a new blocking gate: T2 under t/4092.
const NO_BARE_THROW = ['warn', { baseline: 'lib/eslint-rules/bare-throw-baseline.json' }];

// max-lines is not type-aware, so the .tsx and test blocks parse syntactically
// (no projectService) — those files are outside lib/tsconfig.json's `**/*.ts` project.
const MAX_LINES_SRC = ['error', { max: 1500, skipBlankLines: false, skipComments: false }];
const MAX_LINES_TEST = ['error', { max: 2000, skipBlankLines: false, skipComments: false }];

// ADR-007 §1 soft-warn tiers (t/1695) — advisory early warning BELOW the hard-fail
// ceiling (non-test 1000, test 1500). A single core `max-lines` instance can't emit
// warn@soft AND error@hard (one rule per file, last-match-wins), so this tiny co-located
// rule counts lines the same way core max-lines does (all physical lines, trailing
// newline dropped) and reports at 'warn'. It NEVER fails the build.
// ⚠ t/1692 coordination: do NOT wire `npm run lint --max-warnings=0` in CI — that turns
// these advisory warnings into hard failures and red-walls the soft-band files ADR-007
// intends only to warn on. Wire lib lint with warnings tolerated (or an explicit baseline
// count), not --max-warnings=0.
const SOFT_WARN_SRC = 1000;
const SOFT_WARN_TEST = 1500;
const budgetPlugin = {
  rules: {
    'soft-warn': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Warn when a file trends toward the ADR-007 hard-fail LOC ceiling.' },
        schema: [{ type: 'object', properties: { max: { type: 'number' } }, additionalProperties: false }],
        messages: {
          trending: 'File has {{count}} lines (soft budget {{max}}); trending toward the ADR-007 hard ceiling — plan a cohesion extraction (epic t/1681).',
        },
      },
      create(context) {
        const max = context.options[0]?.max ?? SOFT_WARN_SRC;
        return {
          Program(node) {
            const text = context.sourceCode.getText();
            const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            if (count > max) {
              context.report({ node, messageId: 'trending', data: { count, max } });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  // ── Block A: async safety + LOC budget for non-test source .ts (type-aware) ──
  {
    files: ['**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { budget: budgetPlugin, local: { rules: {
      'no-actionable-error-message-nesting': noActionableErrorMessageNesting,
      'require-warn-on-degraded-catch-return': requireWarnOnDegradedCatchReturn,
      'require-windows-hide': requireWindowsHide,
      'require-windows-hide-unverifiable': requireWindowsHide,
      'require-windows-hide-disable-reason': requireWindowsHideDisableReason,
      'complexity-budget': complexityBudget,
      'no-bare-throw': noBareThrow,
    } } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
      }],
      'max-lines': MAX_LINES_SRC,
      'budget/soft-warn': ['warn', { max: SOFT_WARN_SRC }],
      // ActionableError nesting gate (t/2764 / t/2761): forbid err.message in problem:.
      // Custom rule (not no-restricted-syntax) so it can restrict to error-named identifiers
      // and unwrap TSAsExpression casts — preventing false positives on data.message from
      // HTTP response bodies.
      'local/no-actionable-error-message-nesting': 'error',
      // Silent-fallback gate for lib (t/3224 Phase A, TL ruling t/3224#5). Flags a catch that
      // returns a SILENT empty/no-data default (`[]`/`{}`/`null`/`undefined`) from a DATA/IO path
      // without a WARN/ERROR record — the t/3165 invisible-degradation class the fleet hardened in
      // taxonomy-editor (t/3169/t/3200); lib was previously unguarded. Ships at 'warn' (non-blocking
      // visibility); the GV-gated flip to 'error' follows once the genuine sites (Shared Lib +
      // DebateTool's lib/debate) each carry a WARN or a reasoned disable and the count reaches zero
      // (TL t/3224#5). Scope is degraded-RETURN only — the base require-flight-recorder-in-catch is
      // deliberately NOT extended whole-lib (Phase B t/3263 scopes it to IO subtrees; pure/CLI exempt).
      'local/require-warn-on-degraded-catch-return': 'warn',
      // Flashing-console prevention (t/3914, t/3922): child_process calls need windowsHide: true.
      // Blocking since t/4238 (T2: warn-first from 2026-10-05, then 0 hits in every package for a full CI
      // cycle). Demoting it back to 'warn' is itself a gate change.
      'local/require-windows-hide': ['error', { report: 'missing' }],
      // An unverifiable options object (a wrapper or cross-module options) warns only: no merge is blocked
      // when no fix is available (TL e/351#2). A disable needs a reason + ticket (disable-reason rule).
      'local/require-windows-hide-unverifiable': ['warn', { report: 'unverifiable' }],
      'local/require-windows-hide-disable-reason': 'error',
      // Cyclomatic complexity measurement (t/3823 Phase 1). Advisory only — lib CI gates on errors,
      // not warnings (ci.yml:921). Threshold matches taxonomy-editor's configured value.
      'complexity': ['warn', { max: 15 }],
      // The gate (t/3823 Phase 2): per-file ratchet against lib's own baseline. See the header note.
      'local/complexity-budget': COMPLEXITY_BUDGET,
      'local/no-bare-throw': NO_BARE_THROW,
    },
  },

  // ── Block A-tsx: LOC budget for non-test .tsx (syntactic parse; not in tsconfig project) ──
  {
    files: ['**/*.tsx'],
    ignores: ['**/*.test.tsx', '**/*.spec.tsx', '**/__tests__/**'],
    extends: [tseslint.configs.base],
    plugins: { budget: budgetPlugin, local: { rules: { 'complexity-budget': complexityBudget, 'no-bare-throw': noBareThrow } } },
    rules: {
      'max-lines': MAX_LINES_SRC,
      'budget/soft-warn': ['warn', { max: SOFT_WARN_SRC }],
      // Cyclomatic complexity measurement (t/3823 Phase 1). See Block A note.
      'complexity': ['warn', { max: 15 }],
      'local/complexity-budget': COMPLEXITY_BUDGET,
      'local/no-bare-throw': NO_BARE_THROW,
    },
  },

  // ── Block B: LOC budget for test source (syntactic parse; tests excluded from tsconfig) ──
  // Deliberately NOT the async-safety rules — un-ignoring tests only to enforce the ceiling,
  // not to surface pre-existing floating-promise violations in tests as new gate noise.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    extends: [tseslint.configs.base],
    plugins: { budget: budgetPlugin },
    rules: {
      'max-lines': MAX_LINES_TEST,
      'budget/soft-warn': ['warn', { max: SOFT_WARN_TEST }],
    },
  },

  // ── Generated-file exemption (ADR-007) ──
  // Flat-config `files` globs match by PATH, not content, so a `@generated`-header match
  // is not natively expressible. lib has no generated .ts/.tsx today. When one is added,
  // exempt it here by path, e.g.:
  //   { files: ['path/to/generated.ts'], rules: { 'max-lines': 'off' } },

  // ── Block C: offender baseline (ADR-007, epic t/1681) — REACHED ZERO 2026-07-27 ──
  // All Phase-2 lib/debate splits have landed under budget; the final entry
  // (debate/debateEngine.test.ts → split into lifecycle/modelRouting/signals, t/1686)
  // was removed here. Baseline is now empty — do NOT re-add exemptions; any file over
  // budget (non-test 1500 / test 2000) must fail the gate.

  {
    ignores: ['node_modules/', 'dist/'],
  },
);
