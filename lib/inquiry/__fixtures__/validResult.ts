// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { INQUIRY_SCHEMA_VERSION } from '../schema.js';

// A minimal-but-complete valid InquiryResult fixture, reused across tests.
// Separate from test files to avoid importing test suites (t/4743).
export function makeValidResult(): Record<string, unknown> {
  const node = { nodeId: 'skp-beliefs-029', label: 'Precaution under uncertainty', camp: 'skp' };
  return {
    schemaVersion: INQUIRY_SCHEMA_VERSION,
    request: { question: 'What counts as an AI harm?', fidelity: 'standard' },
    campVerdicts: [{ camp: 'saf', verdict: 'Harm is any foreseeable...', nodes: [node] }],
    convergences: [{ claim: 'All camps accept measurable downstream effects count', nodes: [node] }],
    evidenceLayers: [
      { title: 'Definitional', role: 'Fixes the term', solves: 'Scope disagreement', sources: ['acc-beliefs-004'] },
    ],
    unresolvedGaps: [{ description: 'Threshold for de-minimis harm', confidence: 'low' }],
    calibration: [
      {
        metric: 'claim_acceptance',
        value: 0.857,
        displayValue: '72 / 84',
        trust: { verdict: 'trust', reason: 'natural conclusion — no censoring gate fired', terminationReason: 'natural' },
      },
    ],
    derivation: { fidelity: 'standard', models: { debate: 'gemini-3.1-pro-preview' }, rounds: 6, callBudget: 200 },
    grounding: { anchorSummary: 'AI harm taxonomy', nodesByCamp: { skp: [node] } },
    singleRunCaveat: 'One run is not a finding; the replication gate wants n >= 10.',
  };
}
