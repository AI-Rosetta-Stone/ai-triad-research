// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat turn builder. Cap and BDI floor, statements instead of descriptions, skip-and-backfill
// with one WARN per skip, the deterministic fallback, Scope, Prioritize (▲), situations, and the trace.

import { describe, it, expect, vi } from 'vitest';

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));
import { buildChatTaxonomyTurn, type ChatTurnDeps, type ChatRelevantResult } from './chatTaxonomyTurn';
import type { TaxonomyContext } from './taxonomyContext';
import type { PovNode, SituationNode } from '../../../../lib/debate/taxonomyTypes';

const DESC = 'DESCRIPTION-SHOULD-NEVER-APPEAR';

function node(id: string, category: string, tags: string[] = []): PovNode {
  return {
    id, category, label: `label ${id}`, description: `${DESC} ${id}`, parent_id: null, children: [],
    situation_refs: [], pov_tags: tags,
  } as unknown as PovNode;
}

function situation(id: string): SituationNode {
  return { id, label: `sit ${id}`, description: `sit desc ${id}`, parent_id: null, interpretations: {} } as unknown as SituationNode;
}

/** 10 nodes per BDI category, plus one Other-category node that must never take a BDI slot. */
function ctx(): TaxonomyContext {
  const povNodes: PovNode[] = [];
  for (let i = 0; i < 10; i++) povNodes.push(node(`acc-bel-${i}`, 'Beliefs'));
  for (let i = 0; i < 10; i++) povNodes.push(node(`acc-des-${i}`, 'Desires'));
  for (let i = 0; i < 10; i++) povNodes.push(node(`acc-int-${i}`, 'Intentions'));
  povNodes.push(node('acc-oth-0', 'other'));
  return { povNodes, situationNodes: [situation('sit-1'), situation('sit-2'), situation('sit-3'), situation('sit-4'), situation('sit-5')] };
}

/** Relevance result that scores every pool node, best first in id order. */
function relevanceAll(c: TaxonomyContext): ChatRelevantResult {
  return {
    povNodes: c.povNodes.map((n, i) => ({ nodeId: n.id, score: 1 - i * 0.001 })),
    situationNodes: c.situationNodes.map((n, i) => ({ nodeId: n.id, score: 1 - i * 0.01 })),
  };
}

/** Statements for every pool node: each has text "S-<id>" and index 0. */
function statementsAll(c: TaxonomyContext): Record<string, { text: string; index: number } | null> {
  return Object.fromEntries(c.povNodes.map(n => [n.id, { text: `S-${n.id}`, index: 0 }]));
}

function deps(over: Partial<ChatTurnDeps> = {}, c: TaxonomyContext = ctx()): ChatTurnDeps {
  return {
    computeQueryVector: vi.fn(async () => ({ vector: [0.1, 0.2] })),
    fetchRelevantNodes: vi.fn(async () => relevanceAll(c)),
    chatSyntheticStatements: vi.fn(async () => statementsAll(c)),
    warn: vi.fn(),
    ...over,
  };
}

const QUERY = { topic: 'pause AI?', previousPoverText: 'prev turn', lastUserMessage: 'what about compute?' };

describe('buildChatTaxonomyTurn — cap and statements', () => {
  it('injects at most 12 BDI nodes, each with its statement and never its description', async () => {
    const c = ctx();
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, deps({}, c));
    expect(turn.trace.context_node_ids.length).toBeLessThanOrEqual(12);
    expect(turn.trace.context_node_ids.length).toBe(12);
    expect(turn.block).not.toContain(DESC);
    for (const id of turn.trace.context_node_ids) expect(turn.block).toContain(`S-${id}`);
  });

  it('keeps the BDI floor: the top 2 of each category are reserved', async () => {
    const c = ctx();
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, deps({}, c));
    for (const id of ['acc-bel-0', 'acc-bel-1', 'acc-des-0', 'acc-des-1', 'acc-int-0', 'acc-int-1']) {
      expect(turn.trace.context_node_ids).toContain(id);
    }
  });

  it('never gives a BDI slot to a node outside Beliefs, Desires and Intentions', async () => {
    const c = ctx();
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, deps({}, c));
    expect(turn.trace.context_node_ids).not.toContain('acc-oth-0');
  });

  it('sends the chat query as one claim vector with sourceType chat and no score floor', async () => {
    const c = ctx();
    const d = deps({}, c);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    const payload = (d.fetchRelevantNodes as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.threshold).toBe(0);
    expect(payload.session.sourceType).toBe('chat');
    expect(payload.session.anClaimEmbeddings).toHaveLength(1);
  });
});

describe('buildChatTaxonomyTurn — skip and backfill', () => {
  it('a node with no statement is skipped, WARNed once, and its slot is backfilled', async () => {
    const c = ctx();
    const statements = statementsAll(c);
    statements['acc-bel-0'] = null;
    const d = deps({ chatSyntheticStatements: vi.fn(async () => statements) }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.trace.context_node_ids).not.toContain('acc-bel-0');
    expect(turn.trace.context_node_ids).toHaveLength(12);
    const skipWarns = (d.warn as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string).filter(m => m.includes('no-usable-statement'));
    expect(skipWarns).toHaveLength(1);
    expect(skipWarns[0]).toContain('node=acc-bel-0');
    expect(turn.block).not.toContain(DESC);
  });

  it('a node with no statement and no backfill candidate is omitted, never described', async () => {
    const c: TaxonomyContext = { povNodes: [node('acc-bel-0', 'Beliefs')], situationNodes: [] };
    const d = deps({
      fetchRelevantNodes: vi.fn(async () => ({ povNodes: [{ nodeId: 'acc-bel-0', score: 1 }], situationNodes: [] })),
      chatSyntheticStatements: vi.fn(async () => ({ 'acc-bel-0': null })),
    }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.trace.context_node_ids).toEqual([]);
    expect(turn.block).not.toContain(DESC);
  });
});

describe('buildChatTaxonomyTurn — fallback', () => {
  it('when relevance is unavailable, uses the file-order first 4 per category, capped and WARNed, not the whole taxonomy', async () => {
    const c = ctx();
    const d = deps({ fetchRelevantNodes: vi.fn(async () => { throw new Error('endpoint down'); }) }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.usedFallback).toBe(true);
    expect(turn.trace.context_node_ids.length).toBeLessThanOrEqual(12);
    expect(turn.trace.context_node_ids).toContain('acc-bel-0');
    expect(turn.trace.context_node_ids).toContain('acc-des-0');
    expect(turn.trace.context_node_ids).toContain('acc-int-0');
    const relevanceWarns = mockRecord.mock.calls.map(c => c[0].message as string).filter(m => m.includes('relevance-unavailable'));
    expect(relevanceWarns).toHaveLength(1);
    expect(turn.block).not.toContain(DESC);
  });
});

describe('buildChatTaxonomyTurn — Scope and Prioritize', () => {
  it('Scope: a node outside the scoped pool is never selected, even if relevance returns it', async () => {
    const full = ctx();
    const scoped: TaxonomyContext = { povNodes: full.povNodes.filter(n => n.id.startsWith('acc-bel')), situationNodes: full.situationNodes };
    const d = deps({}, full); // relevance still scores the whole POV
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: scoped, query: QUERY }, d);
    for (const id of turn.trace.context_node_ids) expect(id.startsWith('acc-bel')).toBe(true);
  });

  it('Prioritize: a tagged node is selected first and marked with ▲', async () => {
    const c = ctx();
    c.povNodes[25] = { ...c.povNodes[25], pov_tags: ['seat-a'] } as PovNode; // acc-int-5
    const turn = await buildChatTaxonomyTurn(
      { pov: 'accelerationist', ctx: c, query: QUERY, tagSelection: { tag: 'seat-a', mode: 'prioritize' } as never },
      deps({}, c),
    );
    expect(turn.trace.context_node_ids).toContain('acc-int-5');
    expect(turn.block).toContain('▲ [acc-int-5]');
  });
});

describe('buildChatTaxonomyTurn — situations and trace', () => {
  it('selects at most 4 situations and records their ids', async () => {
    const c = ctx();
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, deps({}, c));
    expect(turn.trace.context_situation_ids).toHaveLength(4);
    expect(turn.trace.context_situation_ids).toEqual(['sit-1', 'sit-2', 'sit-3', 'sit-4']);
  });

  it('records each injected node with its statement index and text', async () => {
    const c = ctx();
    const statements = statementsAll(c);
    statements['acc-bel-0'] = { text: 'the chosen one', index: 7 };
    const turn = await buildChatTaxonomyTurn(
      { pov: 'accelerationist', ctx: c, query: QUERY },
      deps({ chatSyntheticStatements: vi.fn(async () => statements) }, c),
    );
    expect(turn.trace.context_statements).toContainEqual({ node_id: 'acc-bel-0', index: 7, text: 'the chosen one' });
    expect(turn.trace.context_statements).toHaveLength(turn.trace.context_node_ids.length);
  });
});
