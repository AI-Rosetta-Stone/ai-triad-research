// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ESLint flat config (t/3847) — previously absent entirely: nothing linted this app.
// Scoped narrowly to what t/3847 asks for: rules-of-hooks (crash-class parity with the
// other renderer apps, t/2299) + complexity-budget (the ratchet gate this ticket exists
// to close the gap on). Mirrors poviewer/summary-viewer's non-type-aware pattern — the
// typescript-eslint parser is wired so .ts/.tsx files parse; no projectService needed
// since these rules are purely syntactic.
//
// Deliberately NOT wired here: require-flight-recorder-in-catch (ADR-003). This app has
// catch blocks but zero flight-recorder usage anywhere in its tree — enforcing that rule
// at 'error' would require retrofitting those catches first, a separate and larger job
// outside this ticket's scope (t/3847#1).

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import complexityBudget from '../lib/eslint-rules/complexity-budget.js';
import requireWindowsHide from '../lib/eslint-rules/require-windows-hide.js';

const localPlugin = {
  rules: {
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
      // rules-of-hooks (ERROR) — catches conditional/looped/nested hook calls at lint
      // time, the class that crashed the debate popup in taxonomy-editor (t/2298). Kept
      // at full parity across all renderer apps (t/2299).
      'react-hooks/rules-of-hooks': 'error',
      // Built-in stays at 'warn' (SO e/240 condition 1): advisory per-function signal.
      // complexity-budget below is the gate: per-file ratchet against the recorded baseline.
      'complexity': ['warn', { max: 15 }],
      // Per-file cyclomatic complexity budget gate (t/3847, t/3821).
      // Baseline generated from this tree: workflow-app/complexity-baseline.json
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
