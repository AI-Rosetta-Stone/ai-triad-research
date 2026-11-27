// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/827 (spec docs/ux/debate-synthesis-v2.md §13.3): the Strongest arguments rule in the shared builder.

import { describe, it, expect } from 'vitest';
import { buildSynthesisView } from './synthesisView.js';
import { synthesisBrief } from './synthesisBrief.js';
import { debateToMarkdown, type ExportableDebateSession } from './debateExport.js';

const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];

type N = { id: string; text: string; speaker: string; source_entry_id: string; computed_strength?: number; turn_number?: number };
type E = { source: string; target: string; type: string };
const node = (id: string, speaker: string, strength: number | undefined, turn = 1): N =>
  ({ id, text: `claim ${id}`, speaker, source_entry_id: `entry-${id}`, ...(strength === undefined ? {} : { computed_strength: strength }), turn_number: turn });
const edge = (source: string, target: string, type = 'supports'): E => ({ source, target, type });

const view = (network: { nodes: N[]; edges: E[] } | null | undefined, debaters = CAMPS) =>
  buildSynthesisView({ synthesis: {}, debaters, argumentNetwork: network });

describe('buildSynthesisView strongestArguments (t/827)', () => {
  it('is [] with no argument network, and the section has no nav entry', () => {
    for (const n of [undefined, null, { nodes: [], edges: [] }]) {
      const v = view(n as never);
      expect(v.strongestArguments).toEqual([]);
      expect(v.nav.find(x => x.key === 'strongest-arguments')).toBeUndefined();
    }
  });

  it('never shows a node with no edge', () => {
    const v = view({ nodes: [node('a1', 'accelerationist', 0.9), node('a2', 'accelerationist', 0.5)], edges: [edge('a2', 'a1', 'attacks')] });
    // a1 is attacked by a2, so both are engaged here; add an isolated one to check it is dropped
    const w = view({ nodes: [node('a1', 'accelerationist', 0.99), node('s1', 'safetyist', 0.2), node('s2', 'safetyist', 0.1)], edges: [edge('s1', 's2')] });
    expect(w.strongestArguments.find(c => c.camp.id === 'accelerationist')?.items).toEqual([]);
    expect(v.strongestArguments[0].items.map(i => i.id)).toEqual(['a1', 'a2']);
  });

  it('only supports and attacks edges count as engagement; revoice_of does not', () => {
    const v = view({ nodes: [node('a1', 'accelerationist', 0.9), node('a2', 'accelerationist', 0.8)], edges: [edge('a1', 'a2', 'revoice_of')] });
    expect(v.strongestArguments).toEqual([]);
  });

  it('excludes speakers system and document, and speakers that are not a camp', () => {
    const v = view({
      nodes: [node('x1', 'system', 0.99), node('d1', 'document', 0.98), node('u1', 'user', 0.97), node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)],
      edges: [edge('x1', 'k1'), edge('d1', 'k1'), edge('u1', 'k2')],
    });
    const items = v.strongestArguments.flatMap(c => c.items.map(i => i.id));
    expect(items).toEqual(['k1', 'k2']);
  });

  it('ranks by computed_strength, then total edges, then earlier turn, and keeps the top 3', () => {
    const nodes = [
      node('s1', 'safetyist', 0.5, 4), node('s2', 'safetyist', 0.9, 2), node('s3', 'safetyist', 0.5, 1),
      node('s4', 'safetyist', 0.5, 1), node('s5', 'safetyist', undefined, 1), node('o', 'skeptic', 0.1),
    ];
    const edges = [
      edge('o', 's1'), edge('o', 's2'), edge('o', 's3'), edge('o', 's4'), edge('o', 's5'),
      edge('s1', 's3'), // s3 now has 2 edges; s1 has 2 edges too
    ];
    const ids = view({ nodes, edges }).strongestArguments.find(c => c.camp.id === 'safetyist')!.items.map(i => i.id);
    // s2 (0.9) first; then the 0.5 group by edges (s1: 2, s3: 2, s4: 1): s1 and s3 tie on edges, s3 has the earlier turn; s4 is cut by the top 3
    expect(ids).toEqual(['s2', 's3', 's1']);
  });

  it('a missing computed_strength ranks below any number', () => {
    const v = view({ nodes: [node('a1', 'accelerationist', undefined), node('a2', 'accelerationist', 0), node('o', 'skeptic', 0.5)], edges: [edge('o', 'a1'), edge('o', 'a2')] });
    expect(v.strongestArguments[0].items.map(i => i.id)).toEqual(['a2', 'a1']);
  });

  it('counts incoming supports and attacks as supportedBy / challengedBy, and carries the source entry', () => {
    const v = view({
      nodes: [node('a1', 'accelerationist', 0.9), node('s1', 'safetyist', 0.5), node('s2', 'safetyist', 0.4), node('k1', 'skeptic', 0.3)],
      edges: [edge('s1', 'a1', 'attacks'), edge('s2', 'a1', 'attacks'), edge('k1', 'a1', 'supports'), edge('a1', 's1', 'attacks')],
    });
    const a1 = v.strongestArguments.find(c => c.camp.id === 'accelerationist')!.items[0];
    expect(a1).toEqual({ id: 'a1', text: 'claim a1', supportedBy: 1, challengedBy: 2, engages: 1, sourceEntryId: 'entry-a1' });
  });

  it('engages counts the edges where the node is the source, whatever their type', () => {
    const v = view({
      nodes: [node('a1', 'accelerationist', 0.9), node('s1', 'safetyist', 0.5), node('s2', 'safetyist', 0.4), node('k1', 'skeptic', 0.3)],
      edges: [edge('a1', 's1', 'attacks'), edge('a1', 's2', 'supports'), edge('a1', 'k1', 'attacks'), edge('a1', 'k1', 'revoice_of')],
    });
    const a1 = v.strongestArguments.find(c => c.camp.id === 'accelerationist')!.items[0];
    expect(a1).toMatchObject({ supportedBy: 0, challengedBy: 0, engages: 3 });
  });

  it('lists the camps in the fixed order with items: [] for a camp that has none, and counts only camps with items in the nav', () => {
    const v = view({ nodes: [node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)], edges: [edge('k2', 'k1')] }, ['skeptic', 'accelerationist', 'safetyist']);
    expect(v.strongestArguments.map(c => [c.camp.id, c.items.length])).toEqual([['accelerationist', 0], ['safetyist', 0], ['skeptic', 2]]);
    const at = v.nav.map(n => n.key);
    expect(v.nav.find(n => n.key === 'strongest-arguments')?.count).toBe(1);
    expect(at.indexOf('strongest-arguments')).toBeLessThan(at.indexOf('cruxes') === -1 ? 99 : at.indexOf('cruxes'));
  });

  it('only the camps taking part are listed', () => {
    const v = view({ nodes: [node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)], edges: [edge('k2', 'k1')] }, ['skeptic', 'safetyist']);
    expect(v.strongestArguments.map(c => c.camp.id)).toEqual(['safetyist', 'skeptic']);
  });

  it('label swap: swapping two camps\' ids gives the same items under the swapped camps, in the fixed camp order', () => {
    const nodes = [
      node('a1', 'accelerationist', 0.9, 1), node('a2', 'accelerationist', 0.5, 2),
      node('s1', 'safetyist', 0.7, 1), node('s2', 'safetyist', 0.7, 3), node('k1', 'skeptic', 0.2, 1),
    ];
    const edges = [edge('s1', 'a1', 'attacks'), edge('a2', 's1', 'attacks'), edge('k1', 's2'), edge('a1', 'k1', 'attacks'), edge('s2', 'a2')];
    const swap = (sp: string) => (sp === 'accelerationist' ? 'skeptic' : sp === 'skeptic' ? 'accelerationist' : sp);
    const base = view({ nodes, edges }).strongestArguments;
    const swapped = view({ nodes: nodes.map(n => ({ ...n, speaker: swap(n.speaker) })), edges }).strongestArguments;
    const items = (cs: typeof base, id: string) => cs.find(c => c.camp.id === id)!.items.map(i => i.id);
    expect(items(swapped, 'skeptic')).toEqual(items(base, 'accelerationist'));
    expect(items(swapped, 'accelerationist')).toEqual(items(base, 'skeptic'));
    expect(items(swapped, 'safetyist')).toEqual(items(base, 'safetyist'));
    expect(swapped.map(c => c.camp.id)).toEqual(base.map(c => c.camp.id));
  });

  it('ignores malformed nodes and edges', () => {
    const v = buildSynthesisView({
      synthesis: {}, debaters: CAMPS,
      argumentNetwork: { nodes: [null, 'x', { id: 'n' }, node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)], edges: [null, { source: 'k2' }, edge('k2', 'k1'), edge('k2', 'nope')] },
    });
    expect(v.strongestArguments.find(c => c.camp.id === 'skeptic')!.items.map(i => i.id)).toEqual(['k1', 'k2']);
  });
});

describe('the export renders Strongest arguments after Disputes (t/827)', () => {
  const synth = {
    areas_of_disagreement: [{ id: 'd1', point: 'A dispute', type: 'EMPIRICAL', positions: [] }],
    cruxes: [{ question: 'A crux?', type: 'EMPIRICAL' }],
  };
  const network = {
    nodes: [node('s1', 'safetyist', 0.9), node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)],
    edges: [edge('k1', 's1', 'attacks'), edge('k2', 'k1', 'supports'), edge('s1', 'k2', 'attacks')],
  };

  it('puts the section between Disputes and Cruxes, a camp with none says so, and no strength number is shown', () => {
    const md = synthesisBrief(synth, { debaters: CAMPS, argumentNetwork: network }).join('\n');
    const at = (h: string) => md.indexOf(h);
    expect(at('### Disputes')).toBeGreaterThan(-1);
    expect(at('### Strongest arguments')).toBeGreaterThan(at('### Disputes'));
    expect(at('### Cruxes')).toBeGreaterThan(at('### Strongest arguments'));
    expect(md).toContain('The best-engaged arguments from each camp. Strength is the model\'s estimate.');
    expect(md).toContain('No argument from Accelerationist was supported or challenged by another.');
    expect(md).toContain('1. claim s1 (Challenged by 1)');
    expect(md).toContain('Strongest arguments 2');
    expect(md).not.toMatch(/0\.9|0\.4/);
  });

  it("a source-only argument says 'Engages N other argument(s)'; one with incoming edges keeps Supported/Challenged", () => {
    const net = {
      nodes: [node('a1', 'accelerationist', 0.9), node('a2', 'accelerationist', 0.5), node('s1', 'safetyist', 0.4), node('s2', 'safetyist', 0.3), node('k1', 'skeptic', 0.2)],
      edges: [edge('a1', 's1', 'attacks'), edge('a1', 's2', 'attacks'), edge('a2', 'k1', 'attacks'), edge('k1', 's1', 'supports')],
    };
    const md = synthesisBrief(synth, { debaters: CAMPS, argumentNetwork: net }).join('\n');
    expect(md).toContain('1. claim a1 (Engages 2 other arguments)');
    expect(md).toContain('2. claim a2 (Engages 1 other argument)');
    expect(md).toContain('1. claim s1 (Supported by 1 · Challenged by 1)');
    expect(md).not.toContain('(Engages 2 other arguments · ');
  });

  it('omits the section and its nav count when there is no network or nothing engaged', () => {
    for (const n of [undefined, null, { nodes: [node('k1', 'skeptic', 0.4)], edges: [] }]) {
      const md = synthesisBrief(synth, { debaters: CAMPS, argumentNetwork: n }).join('\n');
      expect(md).not.toContain('Strongest arguments');
    }
  });

  it('renders as plain text too', () => {
    const txt = synthesisBrief(synth, { debaters: CAMPS, argumentNetwork: network }, { format: 'text' }).join('\n');
    expect(txt).toContain('STRONGEST ARGUMENTS');
    expect(txt).not.toMatch(/\*\*/);
  });
});

describe('the app export passes the session argument_network through (t/827)', () => {
  it('debateToMarkdown shows Strongest arguments for a concluding entry when the session has a network', () => {
    const session = {
      id: 'x', title: 'T', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phase: 'complete',
      topic: { original: 'o', final: 'The topic' }, active_povers: CAMPS, user_is_pover: false,
      argument_network: { nodes: [node('k1', 'skeptic', 0.4), node('k2', 'skeptic', 0.3)], edges: [edge('k2', 'k1', 'attacks')] },
      transcript: [{ id: '2', timestamp: '2026-01-01T00:01:00Z', speaker: 'system', type: 'concluding', content: 'STORED', taxonomy_refs: [], metadata: { synthesis: { areas_of_agreement: [{ point: 'P', povers: [] }] } } }],
    } as unknown as ExportableDebateSession;
    const md = debateToMarkdown(session);
    expect(md).toContain('#### Strongest arguments');
    expect(md).toContain('1. claim k1 (Challenged by 1)');
    expect(debateToMarkdown({ ...session, argument_network: undefined })).not.toContain('Strongest arguments');
  });
});
