// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the skip WARNs (one per entry), the trace record, and the ▲ marker through the current formatter.

import { describe, it, expect } from 'vitest';
import { chatSkipWarnings, buildChatTurnTrace } from './chatTaxonomyTrace';
import { formatTaxonomyContext } from '../../../../lib/debate/taxonomyContext';
import type { PovNode, SituationNode } from '../../../../lib/debate/taxonomyTypes';

describe('chatSkipWarnings', () => {
  it('emits exactly one WARN per skipped entry', () => {
    const warnings = chatSkipWarnings('accelerationist', ['acc-bel-001', 'acc-des-002']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('node=acc-bel-001');
    expect(warnings[1]).toContain('node=acc-des-002');
    expect(warnings.every(w => w.includes('reason=no-usable-statement'))).toBe(true);
  });

  it('emits nothing when nothing was skipped', () => {
    expect(chatSkipWarnings('skeptic', [])).toEqual([]);
  });
});

describe('buildChatTurnTrace', () => {
  it('records the injected node ids, each statement index and text, and the situation ids', () => {
    const trace = buildChatTurnTrace(
      [
        { nodeId: 'acc-bel-001', statement: { text: 'Scaling helps.', index: 4 } },
        { nodeId: 'acc-int-002', statement: { text: 'Build it.', index: 0 } },
      ],
      ['sit-001', 'sit-003'],
    );
    expect(trace.context_node_ids).toEqual(['acc-bel-001', 'acc-int-002']);
    expect(trace.context_statements).toEqual([
      { node_id: 'acc-bel-001', index: 4, text: 'Scaling helps.' },
      { node_id: 'acc-int-002', index: 0, text: 'Build it.' },
    ]);
    expect(trace.context_situation_ids).toEqual(['sit-001', 'sit-003']);
  });

  it('a turn with nothing selected has an empty trace', () => {
    expect(buildChatTurnTrace([], [])).toEqual({ context_node_ids: [], context_statements: [], context_situation_ids: [], label_only_node_ids: [] });
  });
});

describe('▲ marker through the current formatter (Prioritize)', () => {
  // Tests against the module's current output. The statement hook (Debate Engine) is not in yet, so
  // these lines still carry descriptions; the ▲ prefix is what this test pins.
  const node = (id: string, category: PovNode['category'], pov_tags: string[] = []): PovNode => ({
    id, category, label: `label ${id}`, description: `desc ${id}`, parent_id: null, children: [],
    situation_refs: [], pov_tags,
  } as unknown as PovNode);

  it('marks a Prioritize-tagged node with ▲ and leaves untagged nodes unmarked', () => {
    const povNodes = [node('acc-bel-001', 'Beliefs'), node('acc-bel-002', 'Beliefs', ['tagA'])];
    const out = formatTaxonomyContext(
      { povNodes, situationNodes: [] as SituationNode[] },
      'accelerationist',
      undefined,
      { maxNodes: 9999, maxDesires: 9999, tagSelection: { taggedIds: new Set(['acc-bel-002']), mode: 'prioritize' } },
    );
    expect(out).toContain('▲ [acc-bel-002]');
    expect(out).not.toContain('▲ [acc-bel-001]');
  });
});
