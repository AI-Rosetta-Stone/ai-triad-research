// @vitest-environment node
//
// t/3581 — the non-trivial parts of the server deps assembly: buildGroundingTaxonomy merges the
// per-pov corpus across camps (getAssembledCorpus is per-pov), skips an unreadable camp with a WARN,
// and the stage mapping folds the pipeline's 5-stage vocabulary onto the job store's 4 stages.
// runInquiryPipeline is mocked to capture the assembled deps without running a real pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InquiryPipelineDeps } from '../../../../lib/debate/inquiryPipeline.js';

const h = vi.hoisted(() => ({
  corpora: new Map<string, { povNodes: unknown[]; situationNodes: unknown[]; nodeEmbeddings: Record<string, unknown> }>(),
  fail: new Set<string>(),
  capturedDeps: null as InquiryPipelineDeps | null,
  warnSpy: vi.fn(),
  recordSpy: vi.fn(),
}));

vi.mock('../routes/corpusAssemblyCache.js', () => ({
  getAssembledCorpus: async (pov: string) => {
    if (h.fail.has(pov)) throw new Error(`corpus read failed: ${pov}`);
    return h.corpora.get(pov) ?? { povNodes: [], situationNodes: [], nodeEmbeddings: {}, allNodeIds: [] };
  },
}));
const computeQueryEmbeddingSpy = vi.fn(async (_text: string) => Array.from({ length: 384 }, (_, i) => i / 384));
vi.mock('../ai/aiBackends.js', () => ({
  getModelRegistry: () => ({ backends: [], models: [] }),
  computeEmbeddings: async () => ({ vectors: [] }),
  computeQueryEmbedding: (text: string) => computeQueryEmbeddingSpy(text),
  generateText: vi.fn(),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: vi.fn() }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: () => ({}) }));
vi.mock('../config.js', () => ({ getProjectRoot: () => '/repo' }));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({
  runInquiryPipeline: async (_req: unknown, deps: InquiryPipelineDeps) => { h.capturedDeps = deps; return { schemaVersion: 1 }; },
}));
vi.mock('../logger.js', () => ({ log: { server: { warn: h.warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: h.recordSpy }) }));

import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';

const REQUEST = { question: 'q', fidelity: 'standard' as const };
const ctxOnStage = vi.fn();
const CTX = { onStage: ctxOnStage };

beforeEach(() => {
  h.corpora.clear(); h.fail.clear(); h.capturedDeps = null;
  h.warnSpy.mockClear(); h.recordSpy.mockClear(); ctxOnStage.mockClear();
  computeQueryEmbeddingSpy.mockClear();
  // Each camp's pov file contributes one distinct node + embedding; situations are shared.
  for (const pov of ['accelerationist', 'safetyist', 'skeptic', 'cross-cutting']) {
    h.corpora.set(pov, { povNodes: [{ id: `${pov}-n1` }], situationNodes: [{ id: 'sit-1' }], nodeEmbeddings: { [`${pov}-n1`]: { pov, vector: [0] } } });
  }
});

describe('t/3581 — buildGroundingTaxonomy (camp merge)', () => {
  it('merges povNodes + nodeEmbeddings across all camps; situationNodes taken once', async () => {
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const tax = h.capturedDeps!.taxonomy as unknown as { povNodes: { id: string }[]; situationNodes: unknown[]; nodeEmbeddings: Record<string, unknown> };
    expect(tax.povNodes.map(n => n.id).sort()).toEqual(['accelerationist-n1', 'cross-cutting-n1', 'safetyist-n1', 'skeptic-n1']);
    expect(Object.keys(tax.nodeEmbeddings).length).toBe(4);
    expect(tax.situationNodes).toHaveLength(1); // shared file, not duplicated 4×
  });

  it('skips an unreadable camp with a WARN, keeps the others', async () => {
    h.fail.add('skeptic');
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const tax = h.capturedDeps!.taxonomy as unknown as { povNodes: { id: string }[] };
    expect(tax.povNodes.map(n => n.id)).not.toContain('skeptic-n1');
    expect(tax.povNodes).toHaveLength(3);
    expect(h.warnSpy.mock.calls.some(c => /skeptic/.test(JSON.stringify(c)))).toBe(true);
    expect(h.recordSpy.mock.calls.some(c => c[0]?.level === 'warn')).toBe(true);
  });

  it('all camps unreadable → empty taxonomy + WARN (pipeline degrades to empty grounding)', async () => {
    for (const pov of ['accelerationist', 'safetyist', 'skeptic', 'cross-cutting']) h.fail.add(pov);
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const tax = h.capturedDeps!.taxonomy as unknown as { povNodes: unknown[] };
    expect(tax.povNodes).toHaveLength(0);
    expect(h.warnSpy).toHaveBeenCalled();
  });
});

describe('t/3581 — stage mapping (pipeline 5-stage → job 4-stage)', () => {
  it('folds deriving→grounding and projecting→judging; passes debating/synthesizing through', async () => {
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const onStage = h.capturedDeps!.onStage!;
    onStage('deriving'); onStage('grounding'); onStage('debating'); onStage('projecting'); onStage('synthesizing');
    expect(ctxOnStage.mock.calls.map(c => c[0])).toEqual(['grounding', 'grounding', 'debating', 'judging', 'synthesizing']);
  });
});

// t/4289/t/4290: without computeQueryEmbedding on the server inquiry adapter, every run fell back
// to lexical relevance, skipped claim attribution, and skipped turn embeddings for convergence —
// all three gate on this adapter member being present. Exercises the REAL createInquiryAdapter()
// (via buildInquiryRunPipeline()'s captured deps.adapter), not a fixture — must fail on main
// before the fix (deps.adapter.computeQueryEmbedding undefined) and pass after.
describe('t/4289/t/4290 — server inquiry adapter wires computeQueryEmbedding', () => {
  it('deps.adapter.computeQueryEmbedding is defined and returns a 384-dim vector', async () => {
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const adapter = h.capturedDeps!.adapter;
    expect(adapter.computeQueryEmbedding).toBeDefined();
    const { vector } = await adapter.computeQueryEmbedding!('what is the risk?');
    expect(vector).toHaveLength(384);
    expect(computeQueryEmbeddingSpy).toHaveBeenCalledWith('what is the risk?');
  });

  it('does not swallow a computeQueryEmbedding failure — propagates so the engine\'s own fallback+WARN can handle it', async () => {
    await buildInquiryRunPipeline()(REQUEST, CTX);
    const adapter = h.capturedDeps!.adapter;
    computeQueryEmbeddingSpy.mockRejectedValueOnce(new Error('ONNX runtime unavailable'));
    await expect(adapter.computeQueryEmbedding!('q')).rejects.toThrow('ONNX runtime unavailable');
  });
});
