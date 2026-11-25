// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/541: the grounding query embed. A host that passes `embedQuery` must get the query text and
// must never reach the in-process ONNX session (computeEmbedding). Without it, computeEmbedding is used.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const computeEmbeddingMock = vi.fn(async (_text: string) => [1, 0, 0]);
vi.mock('../embeddings/onnxEmbedding.js', () => ({
  computeEmbedding: (text: string) => computeEmbeddingMock(text),
}));

vi.mock('../debate/taxonomyLoader.js', () => ({
  loadTaxonomy: () => ({
    accelerationist: { nodes: [{ id: 'acc-bel-001', category: 'Belief', label: 'L', description: 'd', parent_id: null, children: [] }] },
    safetyist: { nodes: [{ id: 'saf-bel-001', category: 'Belief', label: 'L', description: 'd', parent_id: null, children: [] }] },
    skeptic: { nodes: [{ id: 'skp-bel-001', category: 'Belief', label: 'L', description: 'd', parent_id: null, children: [] }] },
    situations: { nodes: [{ id: 'sit-001', label: 'L', description: 'd', parent_id: null }] },
    embeddings: {},
  }),
}));

vi.mock('../debate/taxonomyRelevance.js', () => ({
  scoreNodeRelevance: () => new Map(),
  selectRelevantNodes: (nodes: { id: string }[]) => nodes.map(node => ({ node, score: 0.9 })),
  selectRelevantSituationNodes: (nodes: { id: string }[]) => nodes.map(node => ({ node, score: 0.8 })),
}));

vi.mock('./outletBands.js', () => ({
  resolveOutletBand: () => ({ words: 800, guidance: 'guidance' }),
}));

vi.mock('./promptLoader.js', () => ({
  loadAndAssemblePrompt: () => ({ system: 'sys', user: 'user' }),
  assembleReflectionPrompt: () => 'refl',
}));

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateOpEdSet, type OpEdProgressEvent } from './generate.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapter = {
  generateText: async () => JSON.stringify({ headline: 'H', subtitle: 'S', body_markdown: 'Body words here.', word_count: 3 }),
};

const QUERY_TOPIC = 'AI policy';
const QUERY_THESIS = 'Regulate frontier models';

async function run(extraDeps: Record<string, unknown>): Promise<void> {
  const req = {
    set_id: 's1', topic: QUERY_TOPIC,
    params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: QUERY_THESIS } as never,
    povs: ['accelerationist' as const],
  };
  const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT, ...extraDeps };
  for await (const _ev of generateOpEdSet(req, deps as never) as AsyncGenerator<OpEdProgressEvent>) { /* drain */ }
}

describe('generateOpEdSet — grounding query embed (t/541)', () => {
  beforeEach(() => {
    computeEmbeddingMock.mockClear();
  });

  it('with embedQuery: the host gets the query text and computeEmbedding is never called', async () => {
    const embedQuery = vi.fn(async (_text: string) => [1, 0, 0]);
    await run({ embedQuery });

    expect(embedQuery).toHaveBeenCalled();
    const text = embedQuery.mock.calls[0][0];
    expect(text).toContain(QUERY_TOPIC);
    expect(text).toContain(QUERY_THESIS);
    expect(computeEmbeddingMock).not.toHaveBeenCalled();
  });

  it('control: without embedQuery, computeEmbedding is used for the same query', async () => {
    await run({});

    expect(computeEmbeddingMock).toHaveBeenCalled();
    const text = computeEmbeddingMock.mock.calls[0][0];
    expect(text).toContain(QUERY_TOPIC);
    expect(text).toContain(QUERY_THESIS);
  });
});
