// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InquiryResult } from './schema.js';
import { PublicInquiryShareSchema, PUBLIC_INQUIRY_SHARE_VERSION, toPublicInquiryShare } from './publicShare.js';
import { includedFields } from './fieldClassification.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

// A FULLY-populated InquiryResult — every EXCLUDED field present, so the exclusion tests are meaningful.
function makeFullResult(sources: string[] = ['https://example.org/paper', '10.1000/xyz123', 'Some Cited Title']): InquiryResult {
  const node = { nodeId: 'skp-beliefs-029', label: 'Precaution', camp: 'skp' as const };
  return {
    schemaVersion: 1,
    request: { question: 'Should X?', fidelity: 'standard', situationId: 'sit-42', models: { debaters: 'gemini-3.1-pro-preview', evaluator: 'claude-opus-5' } },
    campVerdicts: [{ camp: 'saf', verdict: 'A verdict', nodes: [node] }],
    convergences: [{ claim: 'A convergence', nodes: [node] }],
    evidenceLayers: [{ title: 'Ev', role: 'grounds', solves: 'scope', sources }],
    unresolvedGaps: [{ description: 'a gap', confidence: 'low' }],
    calibration: [{ metric: 'claim_acceptance', value: 0.85, displayValue: '72 / 84', trust: { verdict: 'trust', reason: 'quorum', terminationReason: 'natural', metricFamily: 'convergence' } }],
    derivation: { fidelity: 'standard', models: { debate: 'gemini-3.1-pro-preview' }, rounds: 6, callBudget: 200, callsUsed: 180, costUsd: 4.2 },
    grounding: { anchorSituationId: 'sit-42', anchorSummary: 'ctx', nodesByCamp: { skp: [node] }, situationNodes: [{ nodeId: 'sit-top-1', label: 'Top Situation' }] },
    singleRunCaveat: 'One run is not a finding.',
    debateId: 'debate-abc',
  } as InquiryResult;
}

// Leaf-path walker (mirrors fieldClassification.test) — for the schema ⟷ matrix drift cross-check.
function leafPaths(schema: unknown, prefix = ''): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let s: any = schema;
  while (s?._def?.innerType) s = s._def.innerType;
  const def = s?._def ?? {};
  const shape = typeof s?.shape === 'function' ? s.shape() : s?.shape;
  if (shape && typeof shape === 'object' && !Array.isArray(shape)) {
    return Object.keys(shape).flatMap((k) => leafPaths(shape[k], prefix ? `${prefix}.${k}` : k));
  }
  const element = def.element ?? (def.type && typeof def.type !== 'string' && def.type?._def ? def.type : undefined);
  if (element?._def) return leafPaths(element, prefix);
  if (def.valueType?._def) return leafPaths(def.valueType, prefix);
  return [prefix];
}

describe('toPublicInquiryShare (t/3648 part 2)', () => {
  it('produces a valid PublicInquiryShare (round-trips through the schema)', () => {
    const share = toPublicInquiryShare(makeFullResult());
    expect(PublicInquiryShareSchema.safeParse(share).success).toBe(true);
    expect(share.version).toBe(PUBLIC_INQUIRY_SHARE_VERSION);
    expect(share.request.question).toBe('Should X?');
  });

  it('EXCLUDES every private field — none appears anywhere in the serialized artifact', () => {
    const json = JSON.stringify(toPublicInquiryShare(makeFullResult()));
    // internal ids / operational internals that must never reach an anonymous reader
    expect(json).not.toContain('skp-beliefs-029'); // nodeId
    expect(json).not.toContain('debate-abc');       // debateId
    expect(json).not.toContain('sit-42');           // request.situationId + grounding.anchorSituationId
    expect(json).not.toContain('sit-top-1');        // grounding.situationNodes.nodeId (t/4592)
    expect(json).not.toContain('nodeId');
    expect(json).not.toContain('debateId');
    expect(json).not.toContain('situationId');
    expect(json).not.toContain('callBudget');
    expect(json).not.toContain('callsUsed');
    expect(json).not.toContain('costUsd');
    expect(json).not.toContain('schemaVersion');
    // request.models (the ASK) excluded; derivation.models (what RAN) kept — assert the ask ids are gone
    expect(json).not.toContain('claude-opus-5');    // was only in request.models.evaluator
  });

  it('INCLUDES the must-keep answer + honesty fields', () => {
    const s = toPublicInquiryShare(makeFullResult());
    expect(s.request.fidelity).toBe('standard');
    expect(s.campVerdicts[0].verdict).toBe('A verdict');
    expect(s.campVerdicts[0].nodes[0].label).toBe('Precaution'); // node snapshot kept (label/camp, no id)
    expect(s.calibration[0].trust.verdict).toBe('trust');
    expect(s.calibration[0].trust.reason).toBe('quorum');        // verdict+reason together (SO must-include)
    expect(s.unresolvedGaps[0].description).toBe('a gap');
    expect(s.derivation.models.debate).toBe('gemini-3.1-pro-preview'); // what ran = provenance
    expect(s.derivation.rounds).toBe(6);
    expect(s.grounding.anchorSummary).toBe('ctx');
    expect(s.grounding.situationNodes).toEqual([{ label: 'Top Situation' }]); // nodeId stripped (t/4592)
    expect(s.singleRunCaveat).toContain('One run');
  });

  it('sanitizes evidence sources — drops paths/internal refs with a WARN, keeps URLs/DOIs/titles', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    try {
      const s = toPublicInquiryShare(makeFullResult([
        'https://example.org/a', '10.1000/xyz', 'A Plain Title',   // keep
        '/etc/passwd', 'C:\\secrets\\key.txt', 'file:///home/x', 'smb://host/share', // drop
      ]));
      expect(s.evidenceLayers[0].sources).toEqual(['https://example.org/a', '10.1000/xyz', 'A Plain Title']);
      expect(record).toHaveBeenCalledTimes(4); // one WARN per dropped source
      expect(record.mock.calls[0][0].message).toContain('non-public-safe source');
    } finally {
      clearGlobalRecorder();
    }
  });

  it('caps free-text fields at 280 chars + ellipsis (SO condition 5) — but NOT the core verdict', () => {
    const long = 'x'.repeat(400);
    const r = makeFullResult();
    r.grounding.anchorSummary = long;
    r.unresolvedGaps = [{ description: long, confidence: 'low' }];
    r.convergences = [{ claim: long, nodes: [] }];
    r.evidenceLayers = [{ title: long, role: long, solves: long, sources: [] }];
    r.campVerdicts = [{ camp: 'saf', verdict: long, nodes: [] }]; // core answer — must NOT be capped
    const s = toPublicInquiryShare(r);
    const capped = (v: string) => v.length === 281 && v.endsWith('…'); // 280 kept + ellipsis
    expect(capped(s.grounding.anchorSummary!)).toBe(true);
    expect(capped(s.unresolvedGaps[0].description)).toBe(true);
    expect(capped(s.convergences[0].claim)).toBe(true);
    expect(capped(s.evidenceLayers[0].title)).toBe(true);
    expect(capped(s.evidenceLayers[0].role)).toBe(true);
    expect(capped(s.evidenceLayers[0].solves)).toBe(true);
    // the verdict is the answer, not an excerpt — passes through uncapped
    expect(s.campVerdicts[0].verdict).toBe(long);
    // short text is untouched (no spurious ellipsis)
    expect(toPublicInquiryShare(makeFullResult()).convergences[0].claim).toBe('A convergence');
  });

  it('DRIFT GUARD: the schema shape equals includedFields(public-share) exactly (projector cannot diverge from the matrix)', () => {
    const schemaLeaves = new Set(leafPaths(PublicInquiryShareSchema).filter((p) => p !== 'version')); // version is projection-owned
    const matrixIncluded = new Set(includedFields('public-share'));
    const inSchemaNotMatrix = [...schemaLeaves].filter((p) => !matrixIncluded.has(p)).sort();
    const inMatrixNotSchema = [...matrixIncluded].filter((p) => !schemaLeaves.has(p)).sort();
    expect(inSchemaNotMatrix, `schema exposes fields the matrix excludes: ${inSchemaNotMatrix.join(', ')}`).toEqual([]);
    expect(inMatrixNotSchema, `matrix includes fields the schema omits: ${inMatrixNotSchema.join(', ')}`).toEqual([]);
  });
});
