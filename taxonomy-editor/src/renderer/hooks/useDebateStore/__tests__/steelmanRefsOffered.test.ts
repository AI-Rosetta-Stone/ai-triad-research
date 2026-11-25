// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: the renderer's opening input carries the steelman refs offered by the shared rule
// (offeredSteelmanRefs, lib/debate/steelman.ts), for an empty and a non-empty argument network.
// Harness FIRST so its hoisted mocks register before the store.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { runOpeningPipelineWithRepair, assembleOpeningPipelineResult, getOpeningRepairHints } from '@lib/debate/turnPipeline';
import type { OpeningPipelineInput } from '@lib/debate/turnPipeline';

const LONG = 'This is a sufficiently long opening statement that clears the 50-character minimum guard.';

function setActive(overrides: Record<string, unknown>): void {
  const session = makeSession({ active_povers: ['skeptic', 'safetyist'], phase: 'opening', ...overrides });
  useDebateStore.setState({
    activeDebate: session as unknown as ReturnType<typeof useDebateStore.getState>['activeDebate'],
    activeDebateId: session.id,
    initialCrossRespondRounds: 0,
  });
}

function arrange(): void {
  mockApi.generateText.mockImplementation(async () => ({ text: '{}' }));
  mockApi.computeEmbeddings.mockImplementation(async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]) }));
  vi.mocked(getOpeningRepairHints).mockReturnValue([]);
  vi.mocked(runOpeningPipelineWithRepair).mockImplementation(async () => ({
    stage_diagnostics: [], total_time_ms: 1, topicAlignmentResult: null, qualityGateResult: null, draft: {},
  }) as never);
  vi.mocked(assembleOpeningPipelineResult).mockReturnValue({ statement: LONG, taxonomyRefs: [], meta: { policy_refs: [] } } as never);
}

function openingInputFor(pov: string): OpeningPipelineInput | undefined {
  return vi.mocked(runOpeningPipelineWithRepair).mock.calls.map(c => c[0]).find(i => i.pov === pov);
}

describe('steelmanRefsOffered on the renderer opening input (t/388)', () => {
  beforeEach(() => { vi.clearAllMocks(); arrange(); });

  it('an empty argument network offers no steelman refs', async () => {
    setActive({ argument_network: { nodes: [], edges: [] } });
    await useDebateStore.getState().runOpeningStatements();
    expect(openingInputFor('skeptic')?.steelmanRefsOffered).toEqual([]);
  });

  it('a non-empty network offers the other camps\' steelman nodes, and not the speaker\'s own', async () => {
    setActive({
      argument_network: {
        nodes: [
          { id: 'AN-1', text: 'the safetyist case', steelman_of: 'safetyist', source_entry_id: 'src-1' },
          { id: 'AN-2', text: 'the skeptic case', steelman_of: 'skeptic', source_entry_id: 'src-2' },
          { id: 'AN-3', text: 'an unsourced case', steelman_of: 'safetyist' },
        ],
        edges: [],
      },
    });
    await useDebateStore.getState().runOpeningStatements();
    expect(openingInputFor('skeptic')?.steelmanRefsOffered).toEqual([
      { id: 'AN-1', steelman_of: 'safetyist', text: 'the safetyist case' },
    ]);
  });
});
