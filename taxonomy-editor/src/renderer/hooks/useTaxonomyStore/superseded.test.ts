// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355: the superseded-node split helpers (pure).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PovNode, PovTaxonomyFile } from '../../types/taxonomy';

const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const m = await import('./superseded');

const node = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: id, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);
const file = (nodes: PovNode[]): PovTaxonomyFile => ({ pov: 'accelerationist', last_modified: '2026-01-01', nodes } as PovTaxonomyFile);

const A1 = node('acc-beliefs-001');
const A2 = node('acc-beliefs-002', { superseded_by: 'acc-beliefs-001' }); // a twin, retired in favour of 001
const A3 = node('acc-beliefs-003');

const stateWith = (nodes: PovNode[]) => {
  const base = { supersededNodes: m.EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null };
  return { ...base, ...m.splitForState(base, { accelerationist: file(nodes) }) } as Parameters<typeof m.allNodesById>[0];
};

beforeEach(() => { record.mockClear(); m.__resetSupersededCacheForTests(); });

describe('split and merge', () => {
  it('holds a superseded node out of the selectable list, with its position', () => {
    const s = stateWith([A1, A2, A3]);
    expect(s.accelerationist!.nodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-003']);
    expect(s.supersededNodes.accelerationist).toEqual([{ node: A2, index: 1 }]);
  });

  it('a file with nothing superseded is passed through unchanged (same object)', () => {
    const f = file([A1, A3]);
    expect(m.splitSuperseded(f).file).toBe(f);
  });

  it('save view puts a held node back at its original position, the same object, byte-identical', () => {
    const s = stateWith([A1, A2, A3]);
    const full = m.withSupersededForSave(s);
    expect(full.accelerationist!.nodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-002', 'acc-beliefs-003']);
    expect(full.accelerationist!.nodes[1]).toBe(A2);
    expect(JSON.stringify(full.accelerationist!.nodes[1])).toBe(JSON.stringify(A2));
    expect(s.accelerationist!.nodes).toHaveLength(2); // the live state is not changed by building the view
  });

  it('a held index past the end (the file shrank) is clamped to the end', () => {
    expect(m.mergeHeld([A1], [{ node: A2, index: 5 }]).map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-002']);
  });
});

describe('full-set readers', () => {
  it('allNodesById and povOfNode include superseded nodes; isSuperseded marks them', () => {
    const s = stateWith([A1, A2, A3]);
    expect(m.allNodesById(s).get('acc-beliefs-002')).toBe(A2);
    expect(m.povOfNode(s, 'acc-beliefs-002')).toBe('accelerationist');
    expect(m.isSuperseded(s, 'acc-beliefs-002')).toBe(true);
    expect(m.isSuperseded(s, 'acc-beliefs-001')).toBe(false);
    expect(m.isSuperseded(s, 'nope')).toBe(false);
  });

  it('allPovNodeIds includes superseded ids, so a new id never reuses one', () => {
    expect([...m.allPovNodeIds(stateWith([A1, A2]))].sort()).toEqual(['acc-beliefs-001', 'acc-beliefs-002']);
  });

  it('a dangling superseded_by still counts as superseded (held, never selectable)', () => {
    const s = stateWith([A1, node('acc-beliefs-009', { superseded_by: 'acc-beliefs-999' })]);
    expect(s.accelerationist!.nodes.map(n => n.id)).toEqual(['acc-beliefs-001']);
    expect(m.isSuperseded(s, 'acc-beliefs-009')).toBe(true);
  });
});

describe('read-only edits', () => {
  it('an edit to a superseded id is refused with a WARN', () => {
    expect(m.refuseSupersededEdit(stateWith([A1, A2]), 'acc-beliefs-002', 'updatePovNode')).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('updatePovNode refused') }));
  });

  it('an edit to a live id is allowed, silently', () => {
    const s = stateWith([A1, A2]);
    record.mockClear(); // building the state records its own "held" info event
    expect(m.refuseSupersededEdit(s, 'acc-beliefs-001', 'updatePovNode')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('rename cascade into held nodes (TL p/336#635)', () => {
  it('renaming the replacement rewrites superseded_by, parent_id and children in held nodes', () => {
    const held = { ...m.EMPTY_HELD, accelerationist: [{ index: 0, node: node('acc-beliefs-002', { superseded_by: 'acc-beliefs-001', parent_id: 'acc-beliefs-001', children: ['acc-beliefs-001'] }) }] };
    const out = m.rewriteHeldRefs(held, 'acc-beliefs-001', 'acc-desires-004');
    const n = out.held.accelerationist[0].node;
    expect(n.superseded_by).toBe('acc-desires-004');
    expect(n.parent_id).toBe('acc-desires-004');
    expect(n.children).toEqual(['acc-desires-004']);
    expect(out.changed).toEqual(['accelerationist']);
  });

  it('an unrelated rename leaves held nodes untouched (same objects)', () => {
    const held = { ...m.EMPTY_HELD, accelerationist: [{ index: 0, node: A2 }] };
    const out = m.rewriteHeldRefs(held, 'acc-beliefs-777', 'acc-beliefs-778');
    expect(out.held).toBe(held);
    expect(out.changed).toEqual([]);
  });
});
