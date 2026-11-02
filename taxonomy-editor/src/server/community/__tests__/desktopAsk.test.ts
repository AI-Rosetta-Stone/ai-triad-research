// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { collectAllNodeIds, collectNodeIdsPerSite, pruneUnknownNodeRefs } from '../community.js';
import type { InquiryResult } from '../../../../../lib/inquiry/index.js';

describe('Desktop Ask validation (t/4612, t/4744, B2/B3)', () => {
  const fakeResult = (): InquiryResult => ({
    schemaVersion: 1,
    request: { question: 'test', fidelity: 'standard' },
    campVerdicts: [
      {
        camp: 'acc',
        verdict: 'test verdict',
        nodes: [{ nodeId: 'acc-test-001', label: 'Node 1', camp: 'acc' }],
      },
    ],
    convergences: [
      { claim: 'test', nodes: [{ nodeId: 'saf-test-001', label: 'Node 2', camp: 'saf' }] },
    ],
    evidenceLayers: [],
    unresolvedGaps: [],
    calibration: [],
    derivation: {
      fidelity: 'standard',
      models: {},
      rounds: 1,
      callBudget: 100,
    },
    grounding: {
      anchorSituationId: 'sit-001',
      situationNodes: [{ nodeId: 'sit-001', label: 'Situation' }],
      nodesByCamp: {
        acc: [{ nodeId: 'acc-test-001', label: 'Node 1', camp: 'acc' }],
      },
    },
    singleRunCaveat: 'test',
  });

  describe('B3: Generic nodeId walk (collectAllNodeIds)', () => {
    it('recursively finds all nodeIds', () => {
      const nodeIds = collectAllNodeIds(fakeResult());
      expect(nodeIds).toContain('sit-001');
      expect(nodeIds).toContain('acc-test-001');
      expect(nodeIds).toContain('saf-test-001');
    });

    it('covers new nodeId sites added to schema', () => {
      // Test that walk visits all paths (regression test for B3)
      const result = fakeResult();
      const allIds = collectAllNodeIds(result);
      const perSite = collectNodeIdsPerSite(result);

      // All per-site IDs must be in the generic walk
      Object.values(perSite).flat().forEach(id => {
        expect(allIds).toContain(id);
      });
    });
  });

  describe('B2: Per-site pruning (pruneUnknownNodeRefs)', () => {
    it('prunes from situationNodes', () => {
      const result = fakeResult();
      const taxonomy = new Map([
        ['acc-test-001', true],
        ['saf-test-001', true],
        // sit-001 missing
      ]);

      const { droppedRefs } = pruneUnknownNodeRefs(result, taxonomy);
      expect(droppedRefs).toContain('sit-001');
    });

    it('prunes from convergences', () => {
      const result = fakeResult();
      const taxonomy = new Map([
        ['sit-001', true],
        ['acc-test-001', true],
        // saf-test-001 missing
      ]);

      const { result: pruned, droppedRefs } = pruneUnknownNodeRefs(result, taxonomy);
      expect(droppedRefs).toContain('saf-test-001');
      expect(pruned.convergences).toHaveLength(0);
    });

    it('rejects when all refs unknown', () => {
      const result = fakeResult();
      const taxonomy = new Map();

      expect(() => pruneUnknownNodeRefs(result, taxonomy)).toThrow('All node references unknown');
    });

    it('keeps valid refs in pruned result', () => {
      const result = fakeResult();
      const taxonomy = new Map([
        ['sit-001', true],
        ['acc-test-001', true],
        ['saf-test-001', true],
      ]);

      const { result: pruned } = pruneUnknownNodeRefs(result, taxonomy);
      expect(pruned.convergences[0].nodes[0].nodeId).toBe('saf-test-001');
    });
  });

  describe('B2 per-site regression tests', () => {
    it('validates situationNodes path', () => {
      const result = fakeResult();
      const perSite = collectNodeIdsPerSite(result);
      expect(perSite.situationNodes).toContain('sit-001');
    });

    it('validates nodesByCamp path', () => {
      const result = fakeResult();
      const perSite = collectNodeIdsPerSite(result);
      expect(perSite.nodesByCamp).toContain('acc-test-001');
    });

    it('validates campVerdictNodes path', () => {
      const result = fakeResult();
      const perSite = collectNodeIdsPerSite(result);
      expect(perSite.campVerdictNodes).toContain('acc-test-001');
    });

    it('validates convergenceNodes path', () => {
      const result = fakeResult();
      const perSite = collectNodeIdsPerSite(result);
      expect(perSite.convergenceNodes).toContain('saf-test-001');
    });
  });
});
