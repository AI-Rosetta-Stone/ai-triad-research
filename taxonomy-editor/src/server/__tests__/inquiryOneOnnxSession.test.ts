// @vitest-environment node
// t/561 (server half) / t/520: an inquiry's debate keeps the process at one ONNX session. The PI's staging inquiry was
// killed near 1 GiB because the debate phases loaded a main-thread session next to the worker's (t/520#21, #22).
// This takes the real adapter the server hands the debate runner (buildInquiryRunPipeline → runDebate), and drives it
// with the engine's real phase-embed router (lib/debate embedTexts) and the real aiBackends. Only the two ONNX leaves
// are faked, and they count the sessions each side would load (a side loads its session on its first call).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AIAdapter } from '../../../../lib/debate/aiAdapter.js';
import type { InquiryPipelineDeps } from '../../../../lib/debate/inquiryPipeline.js';

const h = vi.hoisted(() => ({
  mainLoads: 0, workerLoads: 0, mainCalls: 0,
  deps: null as InquiryPipelineDeps | null,
  adapter: null as AIAdapter | null,
}));

vi.mock('../../../../lib/embeddings/onnxEmbedding.js', () => {
  const load = () => { h.mainLoads = 1; };
  return {
    tryWarmup: vi.fn(async () => { load(); return true; }),
    warmup: vi.fn(async () => { load(); }),
    computeEmbedding: vi.fn(async () => { load(); h.mainCalls++; return [0.1, 0.2]; }),
    computeEmbeddings: vi.fn(async (t: string[]) => { load(); h.mainCalls++; return t.map(() => [0.1, 0.2]); }),
  };
});
vi.mock('../../../../lib/embeddings/offThreadEmbedding.js', () => ({
  computeEmbeddingsOffThread: vi.fn(async (t: string[]) => { h.workerLoads = 1; return t.map(() => Float32Array.from([0.1, 0.2])); }),
  isWorkerPoolShedError: () => false,
  poolStats: () => ({ queueDepth: 0, cap: 0, liveSlots: 1 }),
}));
// The debate runner is replaced by a capture of the adapter it is handed; the pipeline by a capture of its deps.
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({
  runHeadlessDebate: vi.fn(async (_c: unknown, adapter: AIAdapter) => { h.adapter = adapter; return { session: { id: 's-1' }, terminationReason: undefined }; }),
}));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({
  runInquiryPipeline: async (_r: unknown, deps: InquiryPipelineDeps) => { h.deps = deps; return { schemaVersion: 1 }; },
}));
vi.mock('../storage/sourcesIndexReader.js', () => ({ loadSourcesIndex: async () => null }));
vi.mock('../storage/debateStore.js', () => ({ saveDebateSession: vi.fn(async () => ({ newVersion: 1 })) }));
vi.mock('../routes/corpusAssemblyCache.js', () => ({ getAssembledCorpus: async () => ({ povNodes: [], situationNodes: [], nodeEmbeddings: {}, allNodeIds: [] }) }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: () => ({ embeddings: {} }) }));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l() } };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }), setGlobalRecorder: vi.fn() }));
vi.mock('../storage/readDataFile.js', () => ({ readDataFile: vi.fn(async () => Buffer.from('{"nodes":{}}')) }));
vi.mock('../ai/fsCache.js', () => ({ readFileWithMtime: vi.fn(() => ({ content: '{}', mtimeMs: 1 })) }));

import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';
import { embedTexts, embedRoute } from '../../../../lib/debate/debateEngine/embedTexts.js';
import { _resetEmbeddingsCacheForTest, _setPythonAvailableForTest } from '../ai/aiBackends.js';

async function serverDebateAdapter(): Promise<AIAdapter> {
  await buildInquiryRunPipeline()({ question: 'q', fidelity: 'standard' } as never, { onStage: vi.fn(), jobId: 'job-1' } as never);
  await h.deps!.runDebate({ model: 'm', topic: 'q' } as never, 'q');
  return h.adapter!;
}

beforeEach(() => {
  h.mainLoads = 0; h.workerLoads = 0; h.mainCalls = 0; h.deps = null; h.adapter = null;
  _resetEmbeddingsCacheForTest();
  _setPythonAvailableForTest(false); // ONNX only, the hosted shape
});
afterEach(() => { delete process.env.EMBEDDING_WORKER_OFFLOAD; });

describe('t/561: an inquiry debate keeps one ONNX session', () => {
  it('the server hands the debate an adapter with a batch embed, so the engine takes the adapter route, not direct ONNX', async () => {
    expect(embedRoute(await serverDebateAdapter())).toBe('adapter-batch');
  });

  it('offload on: query embeds plus the phases\' frame and paragraph batches load the model once, in the worker, never on the main thread', async () => {
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    const adapter = await serverDebateAdapter();
    await adapter.computeQueryEmbedding!(`topic ${Date.now()}`);
    const frames = await embedTexts(adapter, ['frame a', 'frame b', 'frame c']);       // opening.ts
    const paras = await embedTexts(adapter, ['para 1', 'para 2', 'para 3', 'para 4']); // crossRespond.ts
    expect(frames).toHaveLength(3);
    expect(paras).toHaveLength(4);
    expect(h.workerLoads).toBe(1);
    expect(h.mainLoads).toBe(0);
    expect(h.mainCalls).toBe(0);
  });

  it('offload off: the same work loads the model once, on the main thread', async () => {
    const adapter = await serverDebateAdapter();
    await adapter.computeQueryEmbedding!(`topic ${Date.now()}`);
    await embedTexts(adapter, ['frame a', 'frame b']);
    expect(h.mainLoads + h.workerLoads).toBe(1);
    expect(h.mainLoads).toBe(1);
  });
});
