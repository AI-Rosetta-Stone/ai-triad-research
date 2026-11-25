// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { selectChatSituations, CHAT_SITUATION_CAP, type ScoredChatSituation } from './chatTaxonomySituations';

const pool = (): ScoredChatSituation[] => [
  { nodeId: 'sit-001', score: 0.5 },
  { nodeId: 'sit-002', score: 0.9 },
  { nodeId: 'sit-003', score: 0.7 },
  { nodeId: 'sit-004', score: 0.6 },
  { nodeId: 'sit-005', score: 0.4 },
  { nodeId: 'sit-006', score: 0.8 },
];

describe('selectChatSituations: cap and order (t/348#4 item 4)', () => {
  it('selects 4 situations by score, highest first', () => {
    expect(selectChatSituations(pool()).map(s => s.nodeId)).toEqual(['sit-002', 'sit-006', 'sit-003', 'sit-004']);
  });

  it('never exceeds the cap, even with a larger pool', () => {
    expect(selectChatSituations(pool())).toHaveLength(CHAT_SITUATION_CAP);
  });

  it('returns the whole pool when it is smaller than the cap', () => {
    expect(selectChatSituations(pool().slice(0, 2))).toHaveLength(2);
  });

  it('returns nothing for an empty pool', () => {
    expect(selectChatSituations([])).toEqual([]);
  });

  it('a negative or zero cap selects nothing', () => {
    expect(selectChatSituations(pool(), new Set(), -1)).toEqual([]);
    expect(selectChatSituations(pool(), new Set(), 0)).toEqual([]);
  });
});

describe('selectChatSituations: sitPrimary (full vs abbreviated)', () => {
  it('marks the top 2 as full and the other 2 as abbreviated', () => {
    expect(selectChatSituations(pool()).map(s => s.full)).toEqual([true, true, false, false]);
  });

  it('marks all as full when fewer than 2 are selected', () => {
    expect(selectChatSituations(pool().slice(0, 1))).toEqual([{ nodeId: 'sit-001', full: true }]);
  });
});

describe('selectChatSituations: Prioritize boost and ties', () => {
  it('a boosted (tagged) situation ranks ahead of higher-scored ones', () => {
    const ids = selectChatSituations(pool(), new Set(['sit-005'])).map(s => s.nodeId);
    expect(ids[0]).toBe('sit-005');
  });

  it('breaks score ties by id, so the result is deterministic', () => {
    const tied: ScoredChatSituation[] = [
      { nodeId: 'sit-009', score: 0.5 },
      { nodeId: 'sit-002', score: 0.5 },
      { nodeId: 'sit-005', score: 0.5 },
    ];
    expect(selectChatSituations(tied).map(s => s.nodeId)).toEqual(['sit-002', 'sit-005', 'sit-009']);
  });

  it('does not mutate the pool passed in', () => {
    const input = pool();
    const before = input.map(s => s.nodeId);
    selectChatSituations(input);
    expect(input.map(s => s.nodeId)).toEqual(before);
  });
});
