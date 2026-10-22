// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ESLint flat config — ADR-003 flight-recorder-in-catch enforcement.
// Consumes the single canonical rule shared across all apps (lib/eslint-rules,
// t/1929); no local fork. The typescript-eslint parser is wired so .ts/.tsx
// files parse (the rule is purely syntactic — no type-aware projectService
// needed). Rule is 'error' (ADR-003 hard gate): the mini-app catch tree is clean,
// so this ratchets to full parity with taxonomy-editor's 'error' enforcement
// (t/1976 warn→error, after t/1929 wired the rule to actually run here).

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import requireFlightRecorderInCatch from '../lib/eslint-rules/require-flight-recorder-in-catch.js';
import complexityBudget from '../lib/eslint-rules/complexity-budget.js';
import requireWindowsHide from '../lib/eslint-rules/require-windows-hide.js';

const localPlugin = {
  rules: {
    'require-flight-recorder-in-catch': requireFlightRecorderInCatch,
    'complexity-budget': complexityBudget,
    'require-windows-hide': requireWindowsHide,
  },
};

export default tseslint.config(
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { local: localPlugin, 'react-hooks': reactHooks },
    rules: {
      'local/require-flight-recorder-in-catch': 'error',
      // rules-of-hooks (ERROR) — catches conditional/looped/nested hook calls at lint
      // time, the class that crashed the debate popup in taxonomy-editor (t/2298). Kept
      // at full parity across all three renderer apps (t/2299). exhaustive-deps is left
      // off deliberately to avoid warning noise; rules-of-hooks alone covers the crash class.
      'react-hooks/rules-of-hooks': 'error',
      // Built-in stays at 'warn' (SO e/240 condition 1): advisory per-function signal.
      // complexity-budget below is the gate: per-file ratchet against the recorded baseline.
      'complexity': ['warn', { max: 15 }],
      // Per-file cyclomatic complexity budget gate (t/3848, t/3821).
      // Baseline generated from this tree: summary-viewer/complexity-baseline.json
      'local/complexity-budget': ['error', { baseline: './complexity-baseline.json', threshold: 15 }],
      // Flashing-console prevention (t/3914, t/3922): child_process calls need windowsHide: true.
      // Blocking since t/4238 (T2: warn-first from 2026-10-05, then 0 hits in every package for a full CI
      // cycle). Demoting it back to 'warn' is itself a gate change.
      'local/require-windows-hide': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'build/'],
  },
);
