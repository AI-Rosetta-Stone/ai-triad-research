// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TaxonomyServer p/74#49): the server keeps no `turn_validations[*].attempts[*].stage_diagnostics` (and no
// `diagnostics`) on an anonymous debate's save, so a reloaded anonymous debate has attempts without them.
// PromptDiffTree flatMaps every attempt's stage_diagnostics (PromptDiffTree.tsx:321): it must render, not throw.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));

import { PromptDiffTree } from './PromptDiffTree';
import type { DebateSession } from '../../types/debate';

afterEach(cleanup);

const reloaded = (): DebateSession => ({
  id: 'deb-1',
  title: 'A reloaded anonymous debate',
  phase: 'debate',
  active_povers: ['accelerationist', 'safetyist'],
  transcript: [
    { id: 'e1', type: 'opening', speaker: 'accelerationist', content: 'x', timestamp: 't', taxonomy_refs: [] },
    { id: 'e2', type: 'statement', speaker: 'safetyist', content: 'y', timestamp: 't', taxonomy_refs: [] },
  ],
  // diagnostics: dropped by the server. turn_validations kept, with attempts that lost their stage_diagnostics.
  turn_validations: {
    e2: {
      final: { passed: true, process_reward: 0.7, clarifies_taxonomy: [] },
      attempts: [
        { attempt: 1, model: 'm', prompt_delta: '', raw_response: 'r', response_time_ms: 10, validation: { passed: false, clarifies_taxonomy: [] } },
        { attempt: 2, model: 'm', prompt_delta: '', raw_response: 'r', response_time_ms: 12, validation: { passed: true, clarifies_taxonomy: [] } },
      ],
    },
  },
} as unknown as DebateSession);

describe('PromptDiffTree on a reloaded anonymous debate (t/725)', () => {
  it('renders when the attempts have no stage_diagnostics and the debate has no diagnostics', () => {
    const debate = reloaded();
    expect('diagnostics' in debate).toBe(false);
    expect(() => render(<PromptDiffTree debate={debate} focusedEntryId="e2" onSelectNode={() => {}} />)).not.toThrow();
  });

  it('renders when an entry has a trail with no attempts at all', () => {
    const debate = reloaded();
    (debate.turn_validations as Record<string, unknown>).e2 = { final: { passed: true, process_reward: 0.7, clarifies_taxonomy: [] }, attempts: [] };
    expect(() => render(<PromptDiffTree debate={debate} focusedEntryId="e2" onSelectNode={() => {}} />)).not.toThrow();
  });

  it('renders when the debate has no turn_validations at all', () => {
    const debate = reloaded();
    delete (debate as { turn_validations?: unknown }).turn_validations;
    expect(() => render(<PromptDiffTree debate={debate} focusedEntryId={null} onSelectNode={() => {}} />)).not.toThrow();
  });
});
