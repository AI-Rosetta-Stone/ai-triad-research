// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/769 (Quality, #5598): every consumer of a stored synthesis renders the relevance order, not the
// model order. Each test feeds two agreements in model order, the second flagged answers_question,
// and asserts the second comes first. Removing orderSynthesisLists from a consumer fails its test.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { debateToText, debateToMarkdown, type ExportableDebateSession } from './debateExport.js';
import { formatDebateMarkdown } from './formatters.js';
import type { DebateSession } from './types.js';

const FIRST_IN_MODEL_ORDER = 'Supporting point the model listed first';
const ANSWER = 'The answer to the debate question';
const synthesis = {
  areas_of_agreement: [
    { point: FIRST_IN_MODEL_ORDER, povers: ['safetyist'], answers_question: false },
    { point: ANSWER, povers: ['skeptic'], answers_question: true },
  ],
  areas_of_disagreement: [],
  cruxes: [],
};
const expectAnswerFirst = (text: string) => {
  const a = text.indexOf(ANSWER);
  const b = text.indexOf(FIRST_IN_MODEL_ORDER);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(b);
};

const exportable: ExportableDebateSession = {
  id: 'd1', title: 'T', created_at: 't', updated_at: 't', phase: 'closed',
  topic: { original: 'Q?', final: 'Q?' }, active_povers: ['accelerationist', 'safetyist', 'skeptic'], user_is_pover: false,
  transcript: [],
  synthesis: { areas_of_agreement: synthesis.areas_of_agreement, areas_of_disagreement: [] },
};

describe('debateExport.ts renders the relevance order', () => {
  it('debateToText', () => expectAnswerFirst(debateToText(exportable)));
  it('debateToMarkdown', () => expectAnswerFirst(debateToMarkdown(exportable)));
});

describe('formatters.ts renders the relevance order', () => {
  it('formatDebateMarkdown', () => {
    const session = {
      id: 'd1', title: 'T', created_at: 't', updated_at: 't', phase: 'closed',
      topic: { original: 'Q?', refined: null, final: 'Q?' }, source_type: 'topic', source_ref: '', source_content: '',
      active_povers: ['accelerationist', 'safetyist', 'skeptic'], user_is_pover: false, context_summaries: [],
      transcript: [{ id: 'c1', timestamp: 't', type: 'concluding', speaker: 'system', content: 'x', taxonomy_refs: [], metadata: { synthesis } }],
    } as unknown as DebateSession;
    expectAnswerFirst(formatDebateMarkdown(session));
  });
});

describe('repairTranscript.ts writes the relevance order', () => {
  const argv = process.argv;
  let dir = '';
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reorders the stored synthesis and the repaired content', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 't769-repair-'));
    const file = path.join(dir, 'debate.json');
    const session = {
      id: 'd1', title: 'T', created_at: 't', updated_at: 't', phase: 'closed',
      topic: { original: 'Q?', refined: null, final: 'Q?' }, source_type: 'topic', source_ref: '', source_content: '',
      active_povers: ['accelerationist', 'safetyist', 'skeptic'], user_is_pover: false, context_summaries: [],
      // Raw JSON content marks the synthesis entry for repair; the structured data is already in metadata.
      transcript: [{ id: 'c1', timestamp: 't', type: 'concluding', speaker: 'system', content: JSON.stringify(synthesis), taxonomy_refs: [], metadata: { synthesis } }],
    };
    fs.writeFileSync(file, JSON.stringify(session));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [argv[0], 'repairTranscript.ts', file];
    vi.resetModules();
    await import('./repairTranscript.js');

    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = out.transcript.find((e: { type: string }) => e.type === 'concluding');
    expect(entry.metadata.synthesis.areas_of_agreement.map((a: { point: string }) => a.point)).toEqual([ANSWER, FIRST_IN_MODEL_ORDER]);
    expectAnswerFirst(entry.content);
  });
});
