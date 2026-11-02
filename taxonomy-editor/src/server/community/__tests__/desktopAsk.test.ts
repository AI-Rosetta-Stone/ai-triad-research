// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { collectNodeIds, validateDesktopAskPayload } from '../community.js';
import type { InquiryResult } from '../../../../../lib/inquiry/index.js';

describe('Desktop Ask validation (t/4612, t/4744)', () => {
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

  describe('collectNodeIds', () => {
    it('collects from all paths per t/4744#4', () => {
      const nodeIds = collectNodeIds(fakeResult());
      expect(nodeIds).toContain('sit-001');
      expect(nodeIds).toContain('acc-test-001');
      expect(nodeIds).toContain('saf-test-001');
    });
  });

  describe('validateDesktopAskPayload', async () => {
    it('accepts when all nodeIds exist', async () => {
      const taxonomy = new Map([
        ['acc-test-001', true],
        ['saf-test-001', true],
        ['sit-001', true],
      ]);
      const outcome = await validateDesktopAskPayload(fakeResult(), taxonomy);
      expect(outcome.valid).toBe(true);
      expect(outcome.droppedRefs).toHaveLength(0);
    });

    it('drops missing refs', async () => {
      const taxonomy = new Map([['acc-test-001', true]]);
      const outcome = await validateDesktopAskPayload(fakeResult(), taxonomy);
      expect(outcome.valid).toBe(true);
      expect(outcome.droppedRefs.length).toBeGreaterThan(0);
    });

    it('rejects when all refs unknown', async () => {
      const outcome = await validateDesktopAskPayload(fakeResult(), new Map());
      expect(outcome.valid).toBe(false);
    });
  });
});
