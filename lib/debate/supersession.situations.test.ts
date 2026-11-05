// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4872: situation-node coverage for buildSupersessionIndex. Kept SEPARATE from
// supersession.fixture.test.ts (supersession.fixture.test.ts shares its fixture with the
// PowerShell port, tests/TaxonomySupersession.Tests.ps1 — adding situation/cross-kind cases
// there would fail PowerShell's test until the PowerShell follow-up lands cross-kind detection
// too; see t/4872's ticket for that follow-up). This file tests only the TS side, generically,
// over the new type parameter.

import { describe, it, expect } from 'vitest';
import { buildSupersessionIndex, type SupersedableNode } from './supersession.js';

function povNode(id: string, superseded_by?: string): SupersedableNode {
  return { id, superseded_by };
}

function sitNode(id: string, superseded_by?: string): SupersedableNode {
  return { id, superseded_by };
}

describe('buildSupersessionIndex: situation nodes (t/4872)', () => {
  it('a superseded situation resolves to its situation survivor', () => {
    const nodes = [sitNode('sit-486', 'sit-157'), sitNode('sit-157')];
    const { resolveNode, isSuperseded } = buildSupersessionIndex(nodes);
    expect(isSuperseded('sit-486')).toBe(true);
    expect(resolveNode('sit-486')?.id).toBe('sit-157');
  });

  it('allNodesById still returns the superseded situation by id (historical lookup)', () => {
    const nodes = [sitNode('sit-486', 'sit-157'), sitNode('sit-157')];
    const { allNodesById } = buildSupersessionIndex(nodes);
    expect(allNodesById.get('sit-486')?.id).toBe('sit-486');
  });

  it('POV and situation chains resolve independently within one combined index', () => {
    const nodes = [
      povNode('acc-beliefs-001', 'acc-beliefs-002'),
      povNode('acc-beliefs-002'),
      sitNode('sit-486', 'sit-157'),
      sitNode('sit-157'),
    ];
    const { resolveNode, isSuperseded } = buildSupersessionIndex(nodes);
    expect(resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-002');
    expect(resolveNode('sit-486')?.id).toBe('sit-157');
    expect(isSuperseded('acc-beliefs-001')).toBe(true);
    expect(isSuperseded('sit-486')).toBe(true);
    expect(isSuperseded('acc-beliefs-002')).toBe(false);
    expect(isSuperseded('sit-157')).toBe(false);
  });
});

describe('buildSupersessionIndex: cross-kind guard (t/4872, CL ruling p/49#599)', () => {
  it('a situation pointing at a POV node id resolves to no survivor, with a WARN', () => {
    const nodes = [sitNode('sit-486', 'acc-beliefs-002'), povNode('acc-beliefs-002')];
    const warnings: string[] = [];
    const { resolveNode, isSuperseded } = buildSupersessionIndex(nodes, m => warnings.push(m));
    expect(isSuperseded('sit-486')).toBe(true);
    // No survivor: resolveNode falls back to the node itself (same contract as dangling/cycle).
    expect(resolveNode('sit-486')?.id).toBe('sit-486');
    expect(warnings.some(w => w.includes('different node kind'))).toBe(true);
  });

  it('a POV node pointing at a situation id resolves to no survivor, with a WARN', () => {
    const nodes = [povNode('acc-beliefs-001', 'sit-157'), sitNode('sit-157')];
    const warnings: string[] = [];
    const { resolveNode } = buildSupersessionIndex(nodes, m => warnings.push(m));
    expect(resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-001');
    expect(warnings.some(w => w.includes('different node kind'))).toBe(true);
  });

  it('cross-camp POV supersession (acc -> saf) is still allowed — only sit/POV kind is guarded', () => {
    const nodes = [povNode('acc-beliefs-001', 'saf-beliefs-002'), povNode('saf-beliefs-002')];
    const warnings: string[] = [];
    const { resolveNode } = buildSupersessionIndex(nodes, m => warnings.push(m));
    expect(resolveNode('acc-beliefs-001')?.id).toBe('saf-beliefs-002');
    expect(warnings).toEqual([]);
  });

  it('a cross-kind target earlier in a chain still resolves the chain up to that point to no survivor', () => {
    // acc-A -> acc-B -> sit-157 (cross-kind at the last hop)
    const nodes = [
      povNode('acc-A', 'acc-B'),
      povNode('acc-B', 'sit-157'),
      sitNode('sit-157'),
    ];
    const warnings: string[] = [];
    const { resolveNode } = buildSupersessionIndex(nodes, m => warnings.push(m));
    expect(resolveNode('acc-A')?.id).toBe('acc-A');
    expect(resolveNode('acc-B')?.id).toBe('acc-B');
    expect(warnings.some(w => w.includes('different node kind'))).toBe(true);
  });
});
