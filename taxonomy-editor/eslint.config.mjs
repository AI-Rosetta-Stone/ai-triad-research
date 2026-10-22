// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ESLint flat config — async safety + ADR-007 file-size budget.
//
// Two concerns:
//  1. Async safety (fire-and-forget promises, async/sync callback mismatches) plus
//     flight-recorder-in-catch (ADR-003). Type-aware; Prettier owns formatting.
//  2. File-size budget (ADR-007, t/1691) — the max-lines anti-regression gate,
//     mirroring the lib/ half (t/1685). Thresholds: non-test source 1500, test source
//     2000, both counting blank + comment lines (skipBlankLines/skipComments:false)
//     for one stable number. Existing offenders are baselined in Block C and the
//     baseline shrinks monotonically to zero as the epic t/1681 Phase-2 splits land.
//
// t/3822 correction: ADR-007 §1 soft-warn tiers were previously deferred here because
// "npm run verify caps warnings at --max-warnings=4256, so advisory warns would count
// against that ceiling." That reasoning was false on both counts — package.json's
// `verify` script is LOCAL-ONLY (0 references in ci.yml; CI lints via
// `pnpm run --if-present lint` at ci.yml:557, errors-only, no --max-warnings), and the
// 4256 figure was stale (measured 628 warnings on origin/main 704c8f93, 2026-10-01,
// via `eslint src/ --max-warnings=999999` — the ceiling is now set to 650 in
// package.json). The ceiling exists to catch a local warning-count regression before
// it's noticed any other way; it has never gated a merge. Soft-warn tiers remain
// deferred for now as a separate decision, not because of this (false) constraint.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import requireFlightRecorderInCatch from '../lib/eslint-rules/require-flight-recorder-in-catch.js';
import requireWarnOnDegradedCatchReturn from '../lib/eslint-rules/require-warn-on-degraded-catch-return.js';
import noActionableErrorMessageNesting from '../lib/eslint-rules/no-actionable-error-message-nesting.js';
import noUnmanagedModuleResources from './eslint-rules/no-unmanaged-module-resources.js';
import noInlineStyle from './eslint-rules/no-inline-style.js';
import noRawDataRootRead from './eslint-rules/no-raw-data-root-read.js';
import noDataRootWrite from './eslint-rules/no-data-root-write.js';
import complexityBudget from '../lib/eslint-rules/complexity-budget.js';
import requireWindowsHide from '../lib/eslint-rules/require-windows-hide.js';
import noBareThrow from '../lib/eslint-rules/no-bare-throw.js';

const localPlugin = {
  rules: {
    'require-flight-recorder-in-catch': requireFlightRecorderInCatch,
    'require-warn-on-degraded-catch-return': requireWarnOnDegradedCatchReturn,
    'no-unmanaged-module-resources': noUnmanagedModuleResources,
    'no-inline-style': noInlineStyle,
    'no-actionable-error-message-nesting': noActionableErrorMessageNesting,
    'no-raw-data-root-read': noRawDataRootRead,
    'no-data-root-write': noDataRootWrite,
    'complexity-budget': complexityBudget,
    'require-windows-hide': requireWindowsHide,
    'no-bare-throw': noBareThrow,
  },
};

// ADR-007 max-lines thresholds — count every physical line (no skip) for one stable number.
const MAX_LINES_SRC = ['error', { max: 1500, skipBlankLines: false, skipComments: false }];
const MAX_LINES_TEST = ['error', { max: 2000, skipBlankLines: false, skipComments: false }];

// Test-file globs — excluded from the type-aware async/FR blocks (they are un-ignored
// globally only to enforce the LOC ceiling in Block B, not to surface pre-existing
// floating-promise / no-flight-recorder violations in tests as new gate noise).
const TEST_GLOBS = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/__tests__/**'];

export default tseslint.config(
  // ── Block A: async safety + FR + LOC budget for non-test source (type-aware) ──
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: TEST_GLOBS,
    extends: [tseslint.configs.base],
    plugins: { local: localPlugin, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // rules-of-hooks (ERROR) — catches conditional/looped/nested hook calls at lint
      // time. A conditional hook (`isElectronMode() || useFlag(...)`) shipped to main and
      // crashed the debate popup with "Rendered fewer hooks than expected" (t/2298); this
      // gate is what would have blocked it. Hard-gate because the class is a guaranteed
      // runtime crash, not a style nit (t/2299).
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps is deliberately NOT enabled: as a 'warn' it would count against
      // `npm run verify`'s --max-warnings ceiling (see header note), and as an 'error' it
      // would flood the pre-existing tree. rules-of-hooks alone covers the crash class.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
      }],
      '@typescript-eslint/no-use-before-define': ['error', {
        functions: false,
        classes: true,
        variables: true,
        allowNamedExports: false,
      }],
      // Built-in stays at 'warn' (condition 3, SO e/240): it warns per-function when any
      // single function exceeds 15 — advisory only, does not count against --max-warnings
      // in a meaningful way today. Our complexity-budget rule at 'error' below is the gate:
      // it enforces per-file ratchet semantics against a recorded baseline (t/3821).
      'complexity': ['warn', { max: 15 }],
      // Per-file cyclomatic complexity budget gate (t/3821 SO condition 1).
      // Errors when any file regresses its baseline max or countOver.
      // Baseline is write-only-downward: auto-shrinks on decomposition, never grows on regression.
      // Built-in `complexity` above stays at 'warn' — both rules coexist without conflict.
      'local/complexity-budget': ['error', { baseline: '../lib/eslint-rules/complexity-baseline.json', threshold: 15 }],
      // ADR-003 enforcement (t/1323, repo-review B-401): every catch records to the
      // flight recorder. Flipped warn→error once the tree was clean (0 violations).
      'local/require-flight-recorder-in-catch': 'error',
      // t/3200/t/3205 (Fallback-Path Logging): a degraded-default return (`[]`/`{}`/`null`/`undefined`)
      // from a data/IO catch must record at WARN/ERROR. Flipped warn→error at zero-noise (TL Gate
      // Promotion, t/3200#2 / p/342#254): the per-owner cleanup (t/3219–t/3223) + the predicate
      // refinement (#1812) drove the flagged count to 0. Separate rule from the base one so severity
      // is independent.
      'local/require-warn-on-degraded-catch-return': 'error',
      'max-lines': MAX_LINES_SRC,
      // ActionableError nesting gate (t/2764 / t/2761): forbid err.message in problem:.
      // Custom rule (not no-restricted-syntax) so it restricts to error-named identifiers
      // and unwraps TSAsExpression — no false positives on data.message HTTP response fields.
      'local/no-actionable-error-message-nesting': 'error',
      // Flashing-console prevention (t/3914, t/3922): child_process calls need windowsHide: true.
      // Blocking since t/4238 (T2: warn-first from 2026-10-05, then 0 hits in every package for a full CI
      // cycle). Demoting it back to 'warn' is itself a gate change.
      'local/require-windows-hide': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    ignores: TEST_GLOBS,
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'local/no-unmanaged-module-resources': 'warn',
      'local/no-inline-style': 'warn',
    },
  },
  // ── Block A-storage: ban module-level throw-capable calls in server/storage (t/2113, t/2114) ──
  {
    files: ['src/server/storage/**/*.ts'],
    ignores: TEST_GLOBS,
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'Program > ExpressionStatement > CallExpression',
        message:
          'Module-level call expressions are banned in server/storage — they fire at import time and can crash Vitest collection or the container on startup. Move invariant checks into a constructor or explicit init function. See undiciInvariant.ts + GitHubRestClient constructor as the canonical pattern. (t/2113, t/2114)',
      }],
    },
  },
  // ── Block A-dataroot: data-root read gate (t/3093 / t/3087) ──
  // Flags a raw fs read whose path traces to a data-root resolver (the t/3085 migration-remnant
  // class). Promoted warn->error after >=1 green CI cycle since #1633 (TL GV p/336#231, promotion
  // p/392#21; flip t/3113).
  // exit-2 = ESLint unmatched-pattern on explicit file targets; lint by DIRECTORY (`eslint src/`) —
  // a directory target never yields the No-files-matching exit-2, so this error-level gate is
  // deterministic (t/3109).
  // tripwire: green != verified — a new hit is a true positive; silence it only with an inline
  // eslint-disable + TL-approved rationale at the call site, never by baselining here.
  {
    files: ['src/server/**/*.ts'],
    ignores: [
      ...TEST_GLOBS,             // tests hit resolver + fs.read constantly — not migration remnants
      'src/server/storage/**',   // sanctioned home for data-root reads (readDataFile lives here)
      'src/server/config.ts',    // defines the resolver functions themselves
    ],
    rules: {
      'local/no-raw-data-root-read': 'error',
    },
  },
  // ── Block A-dataroot-write: data-root WRITE gate (t/4372, t/4264's AC4) ──
  // Write-side sibling of Block A-dataroot above. Flags a raw fs write (or a literal
  // /mnt/shared path) whose argument traces to a data-root resolver — a staging deployment
  // sharing that root would write onto PROD's share (t/4264: staging wrote/evicted prod's
  // anonymous sessions this way). Class-A writable state must route through
  // getStateRoot()/resolveStatePath() instead (t/2643).
  // Warn-first (T1, t/4372): this PR fixes every current hit, so it starts at zero on the
  // resulting tree. Promotion to 'error' (a blocking CI gate) is T2 per the ticket's own tier
  // note — not done here.
  // tripwire: green != verified — a new hit is a true positive; silence it only with an inline
  // eslint-disable + TL-approved rationale at the call site, never by baselining here.
  {
    files: ['src/server/**/*.ts'],
    ignores: [
      ...TEST_GLOBS,             // tests hit resolver + fs.write constantly — not migration remnants
      'src/server/storage/**',   // sanctioned home for data-root-adjacent writes (the backend itself)
      'src/server/config.ts',    // defines the resolver functions themselves
    ],
    rules: {
      'local/no-data-root-write': 'warn',
    },
  },
  // ── Block A-bare-throw: no bare `throw new Error('…')` in server code (t/4153, root rule #19) ──
  // One rule and one baseline, shared with lib (lib/eslint-rules/no-bare-throw.js). Warn-first ratchet:
  // only a NEW bare throw warns, so today's tree adds no warnings. Promotion to 'error' is T2 (t/4092).
  {
    files: ['src/server/**/*.ts'],
    ignores: TEST_GLOBS,
    rules: {
      'local/no-bare-throw': ['warn', { baseline: 'lib/eslint-rules/bare-throw-baseline.json' }],
    },
  },
  // ── Block B: LOC budget for test source (syntactic parse; tests are outside the
  //    tsconfig project). Deliberately NOT the async/FR rules — un-ignoring tests only
  //    to enforce the ceiling, not to surface pre-existing test violations as gate noise. ──
  {
    files: TEST_GLOBS,
    extends: [tseslint.configs.base],
    rules: {
      'max-lines': MAX_LINES_TEST,
    },
  },

  // ── Generated-file exemption (ADR-007) ──
  // Flat-config `files` globs match by PATH, not content, so a `@generated`-header match
  // is not natively expressible. taxonomy-editor has no generated .ts/.tsx today. When one
  // is added, exempt it here by path, e.g.:
  //   { files: ['src/path/to/generated.ts'], rules: { 'max-lines': 'off' } },

  // ── Block C: offender baseline (ADR-007, epic t/1681) — SHRINKS MONOTONICALLY TO ZERO ──
  // Each entry is the current LOC (origin/main scan 2026-07-22). Remove an entry as its
  // Phase-2 split lands the file under budget. Do NOT add entries for new files — new
  // growth must fail. (ipcHandlers.ts was dropped once t/1689's split landed on
  // origin/main — 38 LOC, under budget.)
  {
    files: [
      // JUSTIFIED STANDING EXCEPTION (t/1688 ruling C) — NOT a pending shrink.
      // Monolithic stateful backend: the transport-seam split (GitHubRestClient) alone
      // lands ~1736 (still >1500), and clearing the ceiling forces a high-risk rewire of
      // the prod disk-cache/manifest layer (58 `this.manifest` sites). Deferred as
      // asymmetric risk. Revisit only if the optional GitHubRestClient follow-up lands.
      'src/server/storage/githubAPIBackend.ts',  // 2169 — justified exception (t/1688)
    ],
    rules: {
      'max-lines': 'off',
    },
  },

  {
    ignores: ['node_modules/', 'dist/', 'build/'],
  },
);
