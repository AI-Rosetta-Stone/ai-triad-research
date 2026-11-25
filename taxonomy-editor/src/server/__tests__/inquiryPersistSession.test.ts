// @vitest-environment node
// t/476 (t/284 item 5, TL p/16#236): the inquiry session is saved by the persistSession dep, after relevance is
// recorded, so the stored session carries the relevance metric. This test uses the REAL debate store on a temp
// data root. It reads the saved session back with loadDebateSession and checks `relevance` is there. On main,
// runDebate saved the session before relevance was recorded, so this read finds no relevance and the test fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { InquiryPipelineDeps } from '../../../../lib/debate/inquiryPipeline.js';

const h = vi.hoisted(() => ({
  capturedDeps: null as InquiryPipelineDeps | null,
  recordSpy: vi.fn(),
  warnSpy: vi.fn(),
  // The pipeline's own relevance step is the lib's job (its own tests). Here the mock plays the pipeline's order:
  // runDebate, then record relevance, then persistSession. The point under test is the server wiring around it.
  pipelineOrder: null as null | ((deps: InquiryPipelineDeps) => Promise<unknown>),
}));

// Heavy collaborators: stubbed, as in inquiryPipelineDeps.test.ts. The debate store itself is NOT mocked.
vi.mock('../routes/corpusAssemblyCache.js', () => ({ getAssembledCorpus: async () => ({ povNodes: [], situationNodes: [], nodeEmbeddings: {}, allNodeIds: [] }) }));
vi.mock('../ai/aiBackends.js', () => ({
  getModelRegistry: () => ({ backends: [], models: [] }),
  computeEmbeddings: async () => ({ vectors: [] }),
  computeQueryEmbedding: async () => Array.from({ length: 384 }, () => 0),
  generateText: vi.fn(),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({
  runHeadlessDebate: async () => ({ session: { id: 'debate-t476-1', topic: { original: 'q' } }, terminationReason: undefined }),
}));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: () => ({ embeddings: {} }) }));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({
  runInquiryPipeline: async (_req: unknown, deps: InquiryPipelineDeps) => {
    h.capturedDeps = deps;
    return h.pipelineOrder ? h.pipelineOrder(deps) : { schemaVersion: 1 };
  },
}));
vi.mock('../logger.js', () => ({ log: { server: { warn: h.warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: h.recordSpy }) }));

import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';
import { runWithUser } from '../security/userContext.js';
import { loadDebateSession } from '../storage/debateStore.js';

const REQUEST = { question: 'Is the sky blue?', fidelity: 'standard' as const };
const CTX = { onStage: vi.fn(), jobId: 'job-t476' };
// Signed-in user: the debate store saves to disk for a signed-in user (an anonymous request uses an in-memory store).
const asUser = <T,>(fn: () => T): T => runWithUser({ principalName: 't476-user', idp: 'github', storageUserId: 't476-user', stableId: 'github:t476-user', isAnonymous: false }, fn);

let root: string;
let savedRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 't476-'));
  savedRoot = process.env.AI_TRIAD_DATA_ROOT;
  process.env.AI_TRIAD_DATA_ROOT = root;
  h.recordSpy.mockClear(); h.warnSpy.mockClear();
  h.capturedDeps = null;
  h.pipelineOrder = null;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT; else process.env.AI_TRIAD_DATA_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The pipeline's order, as lib/debate/inquiryPipeline.ts runs it: runDebate, relevance recorded on the session,
 *  then persistSession once with the same session object. Returns the debateId the pipeline would stamp. */
function pipelineOrderWithRelevance(deps: InquiryPipelineDeps): Promise<unknown> {
  return (async () => {
    const debate = await deps.runDebate({ topic: 'Is the sky blue?' } as never, 'Is the sky blue?', undefined);
    const session = debate.session as { id: string; relevance?: unknown };
    session.relevance = { value: 0.82, method: 'embedding' }; // what recordQuestionRelevance sets
    await deps.persistSession?.(session as never);
    return { schemaVersion: 1, debateId: session.id };
  })();
}

describe('t/476: the saved inquiry session carries the relevance metric (real store)', () => {
  it('reads the saved session back through the real store and finds relevance', async () => {
    h.pipelineOrder = pipelineOrderWithRelevance;
    const runner = buildInquiryRunPipeline();
    const result = await asUser(() => runner(REQUEST as never, CTX as never));
    expect((result as { debateId?: string }).debateId).toBe('debate-t476-1');

    const saved = await asUser(() => loadDebateSession('debate-t476-1')) as { relevance?: unknown; origin?: unknown };
    expect(saved).toBeTruthy();
    expect(saved.relevance).toEqual({ value: 0.82, method: 'embedding' });
    expect(saved.origin).toEqual({ mode: 'inquiry', inquiry_id: 'job-t476' });
  });

  it('a failed save is logged and the job no longer links to the unstored debate', async () => {
    h.pipelineOrder = pipelineOrderWithRelevance;
    const runner = buildInquiryRunPipeline();
    // First run stores debate-t476-1. A second run with the same debate id is refused by the store (mustNotExist).
    await asUser(() => runner(REQUEST as never, CTX as never));
    const second = await asUser(() => runner(REQUEST as never, CTX as never));

    expect((second as { debateId?: string }).debateId).toBeUndefined(); // no dangling link
    expect(h.warnSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-t476' }), expect.stringContaining('t/476'));
    expect(h.recordSpy).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('job-t476') }));
  });
});
