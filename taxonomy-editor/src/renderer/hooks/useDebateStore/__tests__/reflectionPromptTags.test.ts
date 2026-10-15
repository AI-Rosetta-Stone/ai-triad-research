// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-1 (spec t/4211, D-3 on main via #3300): requestReflections hands the reflector each node's pov_tags and
// the seat's wing, so a tagged Skeptic seat is told which nodes are its own, shared, or another wing's.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockApi, mockTaxonomyState, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { reflectionPrompt } from '../../../prompts/debate';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn(), setEventContext: vi.fn() }),
}));

function seed(pov: 'skeptic' | 'accelerationist', seatTag: string | null) {
  const prefix = pov === 'skeptic' ? 'skp' : 'acc';
  const nodes = [
    { id: `${prefix}-beliefs-010`, category: 'Beliefs', label: 'Own', description: 'D1', ...(pov === 'skeptic' ? { pov_tags: ['critical'] } : {}) },
    { id: `${prefix}-beliefs-011`, category: 'Beliefs', label: 'Untagged', description: 'D2' },
  ];
  mockTaxonomyState[pov] = { nodes } as never;
  useDebateStore.setState({
    activeDebate: makeSession({
      phase: 'debate',
      active_povers: [pov],
      ...(seatTag ? { seat_tags: { [pov]: { pov_tag: seatTag, tag_mode: 'scope' } } } : {}),
      transcript: [{
        id: 'e1', timestamp: 't', type: 'statement', speaker: pov, content: 'X',
        taxonomy_refs: nodes.map(n => ({ node_id: n.id })),
        metadata: { injection_manifest: { povNodeIds: nodes.map(n => n.id) } },
      }],
    }) as never,
  });
  mockApi.generateText.mockResolvedValue({ text: JSON.stringify({ reflection_summary: 's', edits: [] }) });
}

// The harness mocks the prompt module; render the real prompt from the arguments the store passed it.
async function reflectionPromptSent(): Promise<string> {
  const mocked = vi.mocked(reflectionPrompt);
  expect(mocked).toHaveBeenCalledTimes(1);
  const actual = await vi.importActual<typeof import('../../../prompts/debate')>('../../../prompts/debate');
  return actual.reflectionPrompt(...mocked.mock.calls[0]);
}

afterEach(() => {
  mockTaxonomyState.skeptic = { nodes: [] } as never;
  mockTaxonomyState.accelerationist = { nodes: [] } as never;
  mockApi.generateText.mockReset();
  vi.mocked(reflectionPrompt).mockClear();
});

describe('reflection prompt carries pov_tags (t/4214 R-1)', () => {
  it('a tagged Skeptic seat sees each node\'s tags and its own wing', async () => {
    seed('skeptic', 'critical');
    await useDebateStore.getState().requestReflections();
    const prompt = await reflectionPromptSent();
    expect(prompt).toContain('[tags: critical]');
    expect(prompt).toContain('[tags: none]'); // the untagged node is common ground
    expect(prompt).toContain('=== YOUR WING ===');
    expect(prompt).toContain('*Critical* wing');
  });

  it('an untagged Skeptic seat sees the tags and the camp-wide guidance', async () => {
    seed('skeptic', null);
    await useDebateStore.getState().requestReflections();
    const prompt = await reflectionPromptSent();
    expect(prompt).toContain('[tags: critical]');
    expect(prompt).toContain('=== TAG GUIDANCE ===');
    expect(prompt).not.toContain('=== YOUR WING ===');
  });

  it('a POV with no registry tags (Accelerationist) gets no tag lines at all', async () => {
    seed('accelerationist', null);
    await useDebateStore.getState().requestReflections();
    const prompt = await reflectionPromptSent();
    expect(prompt).not.toContain('[tags:');
    expect(prompt).not.toContain('TAG GUIDANCE');
  });
});
