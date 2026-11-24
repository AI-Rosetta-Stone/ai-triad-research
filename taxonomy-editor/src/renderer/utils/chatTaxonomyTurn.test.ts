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
    expect(payload.maxTotal).toBeGreaterThan(ctx().povNodes.length);
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
  it('Scope: the relevance cap is not narrowed to the scoped size, so no in-scope node is dropped', async () => {
    const full = ctx();
    const scoped: TaxonomyContext = { povNodes: full.povNodes.filter(n => n.id.startsWith('acc-bel')), situationNodes: full.situationNodes };
    const d = deps({}, full);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: scoped, query: QUERY }, d);
    const payload = (d.fetchRelevantNodes as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.maxTotal).toBeGreaterThan(full.povNodes.length);
  });

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

describe('buildChatTaxonomyTurn — statement batching and transcript (CL p/166#39)', () => {
  it('never asks the statement route for more than 12 ids in one call', async () => {
    const c = ctx();
    const d = deps({}, c);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    const calls = (d.chatSyntheticStatements as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [payload] of calls) expect(payload.nodeIds.length).toBeLessThanOrEqual(12);
  });

  it('a whole-pool request is split: with every statement missing it still asks in rounds of 12, not the pool', async () => {
    const c = ctx();
    const d = deps({ chatSyntheticStatements: vi.fn(async () => ({})) }, c);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    const calls = (d.chatSyntheticStatements as ReturnType<typeof vi.fn>).mock.calls;
    const requested = calls.flatMap(([payload]) => payload.nodeIds as string[]);
    expect(new Set(requested).size).toBe(requested.length);
    expect(calls.every(([payload]) => (payload.nodeIds as string[]).length <= 12)).toBe(true);
    expect(requested.length).toBeLessThan(c.povNodes.length);
  });

  it('sends the same query text in the transcript as in the claim embedding', async () => {
    const c = ctx();
    const d = deps({}, c);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    const payload = (d.fetchRelevantNodes as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const [embeddedText] = (d.computeQueryVector as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.recentTranscript).toBe(embeddedText);
  });
});

describe('buildChatTaxonomyTurn — live-round fixes (TL p/10#248, t/348#62)', () => {
  it('sends pool sizes the route accepts: minPerCategory 1..10, maxTotal 1..500', async () => {
    const c = ctx();
    const d = deps({}, c);
    await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    const payload = (d.fetchRelevantNodes as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.minPerCategory).toBeGreaterThanOrEqual(1);
    expect(payload.minPerCategory).toBeLessThanOrEqual(10);
    expect(payload.maxTotal).toBeGreaterThanOrEqual(1);
    expect(payload.maxTotal).toBeLessThanOrEqual(500);
  });

  it('a statement failure (403) shows the candidates with their labels, not an empty block, and WARNs', async () => {
    const c = ctx();
    const warn = vi.fn();
    const d = deps({
      chatSyntheticStatements: vi.fn(async () => { throw new Error('403 anon_route_blocked'); }),
      warn,
    }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.block.length).toBeGreaterThan(0);
    expect(turn.block).toContain('label acc-bel-0');
    expect(turn.block).not.toContain('DESC');
    expect(turn.trace.context_node_ids.length).toBe(12);
  });
});

describe('buildChatTaxonomyTurn — label fallback only where needed (CL p/166#43, TL p/10#250)', () => {
  it('a later round failing keeps the statements already fetched; only the candidate without one takes its label', async () => {
    const c = ctx();
    // Round 1: every candidate except the first two has a statement, so the first two need a backfill from round 2.
    const round1 = (nodeIds: string[]) => Object.fromEntries(nodeIds.map(id => [id, (id === 'acc-bel-0' || id === 'acc-bel-1') ? null : { text: `S-${id}`, index: 0 }]));
    const d = deps({
      chatSyntheticStatements: vi.fn()
        .mockImplementationOnce(async (p: { nodeIds: string[] }) => round1(p.nodeIds))
        .mockImplementationOnce(async () => { throw new Error('boom'); }),
    }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.block).toContain('S-acc-des-0');
    expect(turn.block).not.toContain('S-acc-bel-0');
    expect(turn.trace.label_only_node_ids.length).toBeGreaterThan(0);
    expect(turn.trace.label_only_node_ids.every(id => !turn.trace.context_statements.find(s => s.node_id === id && s.text.startsWith('S-')))).toBe(true);
    expect(turn.block.startsWith('Note: statements were not available')).toBe(true);
  });

  it('an anonymous session does not call the statement route, uses labels, adds the note, and records them', async () => {
    const c = ctx();
    const statementCall = vi.fn();
    const warn = vi.fn();
    const d = deps({ chatSyntheticStatements: statementCall, warn }, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY, statementsAvailable: false }, d);
    expect(statementCall).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(turn.block).toContain('label acc-bel-0');
    expect(turn.block.startsWith('Note: statements were not available')).toBe(true);
    expect(turn.trace.label_only_node_ids.length).toBe(turn.trace.context_node_ids.length);
  });

  it('with the statement route available and every line having a statement, there is no note and no label-only ids', async () => {
    const c = ctx();
    const d = deps({}, c);
    const turn = await buildChatTaxonomyTurn({ pov: 'accelerationist', ctx: c, query: QUERY }, d);
    expect(turn.block.startsWith('Note:')).toBe(false);
    expect(turn.trace.label_only_node_ids).toEqual([]);
  });
});
