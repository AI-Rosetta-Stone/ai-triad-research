// @vitest-environment node
//
// t/4338 (TL point 2, regression gap from t/3617): "View raw run" returned 404 for every
// inquiry answer since t/3617 shipped the button, and no test caught it because every prior
// test mocked the debate store. This exercises the real round trip through the real
// storage/fileIO.ts + storage/debateStore.ts (an in-memory StorageBackend swapped in, not a
// mock of the save/load functions themselves): the pipeline's runDebate persists the headless
// debate session, then GET /api/debates/:id — the exact route "View raw run" calls — must
// return 200 with that session, not 404.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StorageBackend } from '../storage/storageBackend.js';
import type { InquiryPipelineDeps } from '../../../../lib/debate/inquiryPipeline.js';

const h = vi.hoisted(() => ({
  runHeadlessDebateMock: vi.fn(async () => ({ session: { id: 'inquiry-session-1', title: 'T', phase: 'closed' }, terminationReason: undefined })),
  capturedDeps: null as InquiryPipelineDeps | null,
}));

vi.mock('../routes/corpusAssemblyCache.js', () => ({
  getAssembledCorpus: async () => ({ povNodes: [], situationNodes: [], nodeEmbeddings: {} }),
}));
vi.mock('../ai/aiBackends.js', () => ({
  getModelRegistry: () => ({ backends: [], models: [] }),
  computeEmbeddings: async () => ({ vectors: [] }),
  computeQueryEmbedding: async () => Array.from({ length: 384 }, () => 0),
  generateText: vi.fn(),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: h.runHeadlessDebateMock }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: () => ({ embeddings: {} }) }));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({
  runInquiryPipeline: async (_req: unknown, deps: InquiryPipelineDeps) => { h.capturedDeps = deps; return { schemaVersion: 1 }; },
}));
vi.mock('../config.js', async (importActual) => ({
  ...(await importActual<typeof import('../config.js')>()),
  getProjectRoot: () => '/repo',
}));

import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';
import * as fileIO from '../storage/fileIO.js';
import * as userContext from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerDebatesRoutes } from '../routes/debates.js';
import type { ServerCtx } from '../routes/context.js';

class MemoryBackend implements StorageBackend {
  files = new Map<string, string>();
  private norm(p: string) { return p.replace(/\\/g, '/'); }
  async readFile(p: string): Promise<string | null> { return this.files.get(this.norm(p)) ?? null; }
  async writeFile(p: string, c: string): Promise<void> { this.files.set(this.norm(p), c); }
  async listDirectory(d: string): Promise<string[]> {
    const prefix = this.norm(d) + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split('/')[0]);
    return [...out];
  }
  async deleteFile(p: string): Promise<void> { this.files.delete(this.norm(p)); }
  async fileExists(p: string): Promise<boolean> { return this.files.has(this.norm(p)); }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }
}

const USER_CTX = { principalName: 'alice', idp: 'github', storageUserId: 'alice', isAnonymous: false };
const REQUEST = { question: 'q', fidelity: 'standard' as const };

async function invokeGetDebate(id: string): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Function }[] = [];
  const router = createRouter(routes);
  registerDebatesRoutes(router, {} as unknown as ServerCtx);
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/debates/:id');
  if (!route) throw new Error('route not found');

  const req = { url: `/api/debates/${id}`, method: 'GET', headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false, headersSent: false, req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res);
  return { status, body };
}

let uc: MemoryBackend;

beforeEach(() => {
  uc = new MemoryBackend();
  fileIO.setUserContentBackend(uc);
  h.runHeadlessDebateMock.mockClear();
  h.capturedDeps = null;
});

describe('t/4338 — inquiry debate persists, then "View raw run" loads it (round trip)', () => {
  it('runDebate persists the session, and GET /api/debates/:id then returns 200 with it', async () => {
    await userContext.runWithUser(USER_CTX, async () => {
      await buildInquiryRunPipeline()(REQUEST, { onStage: () => {}, jobId: 'job-rt-1' });
      const config = { model: 'test-model' } as unknown as Parameters<InquiryPipelineDeps['runDebate']>[0];
      await h.capturedDeps!.runDebate(config, 'q');
    });

    const { status, body } = await userContext.runWithUser(USER_CTX, () => invokeGetDebate('inquiry-session-1'));

    expect(status).toBe(200);
    expect((body as { id: string; origin: string; inquiryJobId: string }).id).toBe('inquiry-session-1');
    expect((body as { origin: string }).origin).toBe('inquiry');
    expect((body as { inquiryJobId: string }).inquiryJobId).toBe('job-rt-1');
  });

  it('a result for a NON-existent debateId still 404s (sanity — the fix does not make loadDebateSession lenient)', async () => {
    const { status } = await userContext.runWithUser(USER_CTX, () => invokeGetDebate('never-saved'));
    expect(status).toBe(404);
  });
});
