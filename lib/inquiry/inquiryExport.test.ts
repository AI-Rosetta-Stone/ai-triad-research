// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inquiryToJson,
  inquiryToMarkdown,
  inquiryToPrintHtml,
  inquiryExportFilename,
  exportableResult,
} from './inquiryExport.js';
import type { InquiryResult } from './schema.js';
import { CLASSIFICATION, dispositionFor, includedFields } from './fieldClassification.js';

const EXPORTED_AT = '2026-07-10T14:30:00.000Z';
const FIXED_DATE = new Date(EXPORTED_AT);

function makeResult(overrides: Partial<InquiryResult> = {}): InquiryResult {
  return {
    schemaVersion: 1,
    request: { question: 'Should frontier training be paused?', fidelity: 'standard' },
    campVerdicts: [
      { camp: 'acc', verdict: 'Pausing forfeits the safety benefits of iterative deployment.', nodes: [{ nodeId: 'acc-beliefs-012', label: 'Iterative deployment is safer', camp: 'acc' }] },
      { camp: 'saf', verdict: 'A pause buys time for alignment to catch up.', nodes: [] },
    ],
    convergences: [
      { claim: 'Both camps agree evaluations are currently inadequate.', nodes: [{ nodeId: 'cc-beliefs-003', label: 'Evals are weak', camp: 'cc' }] },
    ],
    evidenceLayers: [
      { title: 'Compute trends', role: 'Grounds the capability trajectory', solves: 'Whether a pause is enforceable', sources: ['Epoch 2026', 'internal-memo'] },
    ],
    unresolvedGaps: [
      { description: 'No agreed metric for "dangerous capability".', confidence: 'low' },
    ],
    calibration: [
      { metric: 'claim acceptance', value: 0.857, displayValue: '72 / 84', trust: { verdict: 'trust', reason: 'quorum met' } },
    ],
    derivation: { fidelity: 'standard', models: { debate: 'xai-grok-4-7' }, rounds: 5, callBudget: 40, callsUsed: 37 },
    grounding: { anchorSummary: 'Frontier pause debate', nodesByCamp: {} },
    singleRunCaveat: 'Single run; results are not replicated (n ≥ 10 gate not met).',
    ...overrides,
  } as InquiryResult;
}

describe('inquiryExport', () => {
  describe('inquiryToMarkdown', () => {
    it('renders the question as H1 (default title) and the derivation receipt', () => {
      const md = inquiryToMarkdown(makeResult(), { exportedAt: EXPORTED_AT });
      expect(md).toContain('# Should frontier training be paused?');
      expect(md).toContain('**Fidelity:** standard');
      expect(md).toContain('**Rounds:** 5');
      expect(md).toContain('Call budget:** 40 (used 37)');
    });

    it('renders each camp verdict under its display label with refs', () => {
      const md = inquiryToMarkdown(makeResult(), { exportedAt: EXPORTED_AT });
      expect(md).toContain('### Accelerationist');
      expect(md).toContain('### Safetyist');
      expect(md).toContain('> refs: acc-beliefs-012 "Iterative deployment is safer"');
    });

    it('renders convergences, evidence, gaps, calibration, and the single-run caveat', () => {
      const md = inquiryToMarkdown(makeResult(), { exportedAt: EXPORTED_AT });
      expect(md).toContain('## Convergences');
      expect(md).toContain('Both camps agree evaluations are currently inadequate.');
      expect(md).toContain('## Evidence');
      expect(md).toContain('Compute trends');
      expect(md).toContain('## Unresolved gaps');
      expect(md).toContain('## Calibration');
      expect(md).toContain('claim acceptance: 72 / 84 (trust)');
      expect(md).toContain('Single run; results are not replicated');
    });

    it('flags a truncated run in the header', () => {
      const truncated = makeResult({
        calibration: [{ metric: 'convergence', value: 0, trust: { verdict: 'censored', reason: 'ceiling hit', terminationReason: 'api_ceiling' } }],
      });
      const md = inquiryToMarkdown(truncated, { exportedAt: EXPORTED_AT });
      expect(md).toContain('⚠ truncated (api_ceiling)');
    });

    it('uses the question when no title override is given, and the override when present', () => {
      const md = inquiryToMarkdown(makeResult(), { title: 'Custom Title', exportedAt: EXPORTED_AT });
      expect(md).toContain('# Custom Title');
    });
  });

  describe('inquiryToPrintHtml', () => {
    it('produces a valid HTML document with print styles', () => {
      const html = inquiryToPrintHtml(makeResult(), { exportedAt: EXPORTED_AT });
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('break-inside: avoid');
      expect(html).toContain('<title>Should frontier training be paused?</title>');
    });

    it('colors camp headings and renders each section', () => {
      const html = inquiryToPrintHtml(makeResult(), { exportedAt: EXPORTED_AT });
      expect(html).toContain('color: #2e7d32'); // acc
      expect(html).toContain('Accelerationist');
      expect(html).toContain('<h2>Convergences</h2>');
      expect(html).toContain('<h2>Calibration</h2>');
    });

    it('escapes HTML in answer content (no injection)', () => {
      const evil = makeResult({
        campVerdicts: [{ camp: 'acc', verdict: 'Danger <script>alert("xss")</script>', nodes: [] }],
      });
      const html = inquiryToPrintHtml(evil, { exportedAt: EXPORTED_AT });
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('marks truncation in the meta line', () => {
      const truncated = makeResult({
        calibration: [{ metric: 'convergence', value: 0, trust: { verdict: 'censored', reason: 'x', terminationReason: 'situation_cap' } }],
      });
      const html = inquiryToPrintHtml(truncated, { exportedAt: EXPORTED_AT });
      expect(html).toContain('inquiry-truncated');
      expect(html).toContain('situation_cap');
    });
  });

  describe('inquiryToJson', () => {
    it('wraps the full result in a versioned envelope with the question and injected timestamp', () => {
      const json = inquiryToJson(makeResult(), { exportedAt: EXPORTED_AT });
      const parsed = JSON.parse(json);
      expect(parsed.schema).toBe('ai-triad-inquiry-export/1');
      expect(parsed.question).toBe('Should frontier training be paused?');
      expect(parsed.exportedAt).toBe(EXPORTED_AT);
      expect(parsed.result.campVerdicts).toHaveLength(2);
      expect(parsed.result.singleRunCaveat).toContain('Single run');
    });

    it('round-trips the result unchanged', () => {
      const result = makeResult();
      const parsed = JSON.parse(inquiryToJson(result, { exportedAt: EXPORTED_AT }));
      expect(parsed.result).toEqual(result);
    });
  });

  describe('inquiryExportFilename', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_DATE); });
    afterEach(() => { vi.useRealTimers(); });

    it('generates inquiry-<slug>-<date>.<ext>', () => {
      expect(inquiryExportFilename('Should frontier training be paused?', 'md'))
        .toBe('inquiry-should-frontier-training-be-paused-20260710.md');
    });

    it('falls back to untitled for an empty title', () => {
      expect(inquiryExportFilename('', 'json')).toBe('inquiry-untitled-20260710.json');
    });

    it('strips special characters and truncates long titles to 60 chars', () => {
      expect(inquiryExportFilename('Hello! World? <test>', 'pdf')).toBe('inquiry-hello-world-test-20260710.pdf');
      const slug = inquiryExportFilename('A'.repeat(100), 'md').replace('inquiry-', '').replace('-20260710.md', '');
      expect(slug.length).toBeLessThanOrEqual(60);
    });
  });

  describe('export is by-decision, not pass-through (t/3648 part 3 / t/3624; t/285 TL p/35#86)', () => {
    it('the export surface excludes exactly the gated leaves, and the download is the projection of the matrix', () => {
      // LIVE-DERIVED from CLASSIFICATION, not a frozen list, so matrix growth is caught. The export is a projection now
      // (exportableResult), so an exclusion is allowed only when the projection removes it. The expected set is
      // explicit: a new export exclusion must be added here on purpose, with the projection updated to match.
      const allClassified = Object.keys(CLASSIFICATION).sort();
      const exportIncluded = includedFields('export').sort();
      const nowExcluded = allClassified.filter((p) => !exportIncluded.includes(p));
      const instruction =
        `export exclusions changed (now: ${nowExcluded.join(', ')}). Update exportableResult in inquiryExport.ts ` +
        'to strip each newly excluded leaf, then list it here.';
      expect(nowExcluded, instruction).toEqual(['questionDrift.warning']);
    });

    it('the download omits the gated warning but keeps the drift topic and score (t/285, TL p/35#86)', () => {
      const result = makeResult({
        questionDrift: { debatedTopic: 'Other topic', driftScore: 0.4, warning: true },
      } as Partial<InquiryResult>);
      const parsed = JSON.parse(inquiryToJson(result, { exportedAt: EXPORTED_AT }));
      expect(parsed.result.questionDrift).toEqual({ debatedTopic: 'Other topic', driftScore: 0.4 });
      expect(exportableResult(result).questionDrift).not.toHaveProperty('warning');
      // The stored result itself is not mutated.
      expect((result as { questionDrift?: { warning?: boolean } }).questionDrift?.warning).toBe(true);
    });

    it('a sanity spot-check: known fields are export-included (debateId INCLUDE — the worked example)', () => {
      expect(dispositionFor('debateId', 'export').include).toBe(true);
      expect(dispositionFor('derivation.costUsd', 'export').include).toBe(true);
    });
  });
});
