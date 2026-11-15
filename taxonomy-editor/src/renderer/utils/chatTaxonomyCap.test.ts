// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat node cap. Cap and BDI floor, Prioritize ordering, and skip-and-backfill.

import { describe, it, expect } from 'vitest';
import {
  selectChatCandidates, resolveChatNodes, formatChatNodeLine, CHAT_NODE_CAP, type ScoredChatNode, type ChatStatement,
} from './chatTaxonomyCap';

function pool(): ScoredChatNode[] {
  const out: ScoredChatNode[] = [];
  for (let i = 0; i < 10; i++) out.push({ nodeId: `b${i}`, category: 'Beliefs', score: 0.9 - i * 0.01 });
  for (let i = 0; i < 10; i++) out.push({ nodeId: `d${i}`, category: 'Desires', score: 0.8 - i * 0.01 });
  for (let i = 0; i < 10; i++) out.push({ nodeId: `i${i}`, category: 'Intentions', score: 0.7 - i * 0.01 });
  out.push({ nodeId: 'o1', category: 'other', score: 0.99 });
  return out;
}

describe('selectChatCandidates — cap and BDI floor', () => {
  it('returns at most 12 nodes', () => {
    expect(selectChatCandidates(pool())).toHaveLength(CHAT_NODE_CAP);
  });

  it('reserves the top 2 of each BDI category', () => {
    const ids = selectChatCandidates(pool());
    for (const prefix of ['b', 'd', 'i']) {
      const top = [`${prefix}0`, `${prefix}1`];
      for (const id of top) expect(ids).toContain(id);
    }
  });

  it('fills the remaining 6 by score from any BDI category', () => {
    const ids = selectChatCandidates(pool());
    // 6 reserved (b0, b1, d0, d1, i0, i1). The next 6 by score are b2..b7 (0.88 down to 0.83): Beliefs
    // lead every score here, so all six come from Beliefs.
    expect(ids.filter(id => id.startsWith('b'))).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']);
    expect(ids.filter(id => id.startsWith('d'))).toEqual(['d0', 'd1']);
    expect(ids.filter(id => id.startsWith('i'))).toEqual(['i0', 'i1']);
  });

  it('never gives a reserved slot to a node outside the BDI categories', () => {
    expect(selectChatCandidates(pool())).not.toContain('o1');
  });

  it('keeps every BDI node when the pool is smaller than the cap', () => {
    const small: ScoredChatNode[] = [
      { nodeId: 'b0', category: 'Beliefs', score: 0.5 },
      { nodeId: 'd0', category: 'Desires', score: 0.4 },
    ];
    expect(selectChatCandidates(small).sort()).toEqual(['b0', 'd0']);
  });

  it('Prioritize: tagged nodes lead the pool and still count toward the cap', () => {
    const ids = selectChatCandidates(pool(), new Set(['i9']));
    expect(ids).toContain('i9');
    expect(ids).toHaveLength(CHAT_NODE_CAP);
  });
});

describe('resolveChatNodes — skip and backfill', () => {
  it('keeps every node when each has a statement', () => {
    const ids = selectChatCandidates(pool());
    const statements = Object.fromEntries(ids.map((id, i) => [id, { text: `s-${id}`, index: i }]));
    const { kept, skipped } = resolveChatNodes(pool(), ids, statements);
    expect(kept).toHaveLength(CHAT_NODE_CAP);
    expect(skipped).toEqual([]);
  });

  it('a node with no statement is skipped and its slot is backfilled from the same category', () => {
    const ids = selectChatCandidates(pool());
    // The caller looks up statements for the whole BDI pool, so a backfill has a statement to take.
    const statements: Record<string, ChatStatement | null> = Object.fromEntries(pool().map((n, i) => [n.nodeId, { text: `s-${n.nodeId}`, index: i }]));
    statements.b0 = null;
    const { kept, skipped } = resolveChatNodes(pool(), ids, statements);
    expect(skipped).toEqual(['b0']);
    expect(kept.map(k => k.nodeId)).not.toContain('b0');
    // The next-scored unpicked Belief, b6, takes the slot.
    expect(kept.map(k => k.nodeId)).toContain('b6');
    expect(kept).toHaveLength(CHAT_NODE_CAP);
  });

  it('a backfill never picks a node that is already a candidate', () => {
    const ids = selectChatCandidates(pool());
    const statements: Record<string, ChatStatement | null> = Object.fromEntries(pool().map((n, i) => [n.nodeId, { text: `s-${n.nodeId}`, index: i }]));
    statements.b0 = null;
    const { kept } = resolveChatNodes(pool(), ids, statements);
    const keptIds = kept.map(k => k.nodeId);
    expect(new Set(keptIds).size).toBe(keptIds.length);
  });

  it('carries each chosen statement index into the kept node, for the trace (t/348#4 rule 4)', () => {
    const ids = selectChatCandidates(pool());
    const statements: Record<string, ChatStatement | null> = Object.fromEntries(pool().map((n, i) => [n.nodeId, { text: `s-${n.nodeId}`, index: i + 3 }]));
    const { kept } = resolveChatNodes(pool(), ids, statements);
    for (const k of kept) {
      expect(k.index).toBe(statements[k.nodeId]!.index);
      expect(k.statement).toBe(statements[k.nodeId]!.text);
    }
  });

  it('a backfilled node records its own statement index, not the skipped one\'s', () => {
    const ids = selectChatCandidates(pool());
    const statements: Record<string, ChatStatement | null> = Object.fromEntries(pool().map((n, i) => [n.nodeId, { text: `s-${n.nodeId}`, index: i + 3 }]));
    statements.b0 = null;
    const { kept } = resolveChatNodes(pool(), ids, statements);
    const backfill = kept.find(k => k.nodeId === 'b6')!;
    expect(backfill.index).toBe(statements.b6!.index);
    expect(backfill.statement).toBe('s-b6');
    expect(kept.find(k => k.nodeId === 'b0')).toBeUndefined();
  });
});

describe('formatChatNodeLine', () => {
  it('formats as [id] "label" — statement, never a description', () => {
    expect(formatChatNodeLine({ id: 'acc-bel-001', label: 'Capability gains' }, 'Scaling helps.'))
      .toBe('[acc-bel-001] "Capability gains" — Scaling helps.');
  });
});
