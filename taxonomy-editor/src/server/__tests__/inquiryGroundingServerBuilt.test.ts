// @vitest-environment node
//
// t/4256 — regression for t/4253: buildGroundingTaxonomy (inquiryPipelineDeps.ts) assembles its
// corpus per-pov via getAssembledCorpus(povFile), and assembleNodeEmbeddings (relevanceSelection.ts,
// unchanged by this fix) stamps every resulting embedding's `pov` with the POV FILE NAME it was
// called with ('accelerationist'/'safetyist'/'skeptic') — never with a camp CODE ('acc'/'saf'/'skp').
// buildGroundingEnvelope's camp-matching (lib/debate/inquiryGrounding.ts, isCamp(embedding.pov)
// against VALID_CAMPS = {acc,saf,skp,cc}) therefore rejects every embedding, leaving nodesByCamp
// permanently empty for every hosted inquiry. The fix lands in inquiryGrounding.ts (DebateTool's
// t/4255, sibling ticket) — this file is untouched by it.
//
// This test builds the REAL server taxonomy (via buildInquiryRunPipeline, mocking only
// getAssembledCorpus + the pipeline's other external deps — same pattern as
// inquiryPipelineDeps.test.ts) with embeddings stamped the way assembleNodeEmbeddings actually
// stamps them today (the pov file name), then feeds the captured taxonomy into the REAL (unmocked)
// buildGroundingEnvelope. This is the fault arm the ticket asks to record: it fails on
// origin/main before t/4255 lands (nodesByCamp comes back empty) and must pass once
// buildGroundingEnvelope's camp matching correctly recognizes pov-file-name-stamped embeddings.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InquiryPipelineDeps } from '../../../../lib/debate/inquiryPipeline.js';
import { buildGroundingEnvelope } from '../../../../lib/debate/inquiryGrounding.js';
import type { PovNode } from '../../../../lib/debate/taxonomyTypes.js';

const h = vi.hoisted(() => ({
  corpora: new Map<string, { povNodes: unknown[]; situationNodes: unknown[]; nodeEmbeddings: Record<string, unknown> }>(),
  capturedDeps: null as InquiryPipelineDeps | null,
}));

vi.mock('../routes/corpusAssemblyCache.js', () => ({
  getAssembledCorpus: async (pov: string) => h.corpora.get(pov) ?? { povNodes: [], situationNodes: [], nodeEmbeddings: {}, allNodeIds: [] },
}));
vi.mock('../ai/aiBackends.js', () => ({
  getModelRegistry: () => ({ backends: [], models: [] }),
  computeEmbeddings: async () => ({ vectors: [] }),
  generateText: vi.fn(),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: vi.fn() }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: () => ({}) }));
vi.mock('../config.js', () => ({ getProjectRoot: () => '/repo' }));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({
  runInquiryPipeline: async (_req: unknown, deps: InquiryPipelineDeps) => { h.capturedDeps = deps; return { schemaVersion: 1 }; },
}));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';

const REQUEST = { question: 'q', fidelity: 'standard' as const };
const CTX = { onStage: vi.fn() };

// A single-vector embed cb: every text gets the same unit vector, so every node is maximally
// similar to the question — scoring/ranking is irrelevant here, only camp membership is.
const fakeEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0]);

function makeNode(id: string, tags?: string[]): PovNode {
  return {
    id, category: 'beliefs', label: id, description: `node ${id}`, parent_id: null, children: [],
    ...(tags ? { pov_tags: tags } : {}),
  } as unknown as PovNode;
}

// real-shaped assembleNodeEmbeddings output: `base[id] = { pov: povFile, vector }` — every entry
// stamped with the POV FILE NAME it was assembled under (relevanceSelection.ts:84), exactly as
// production does today. This shape is NOT changed by t/4255; only inquiryGrounding.ts's reader
// side is.
function corpusFor(povFile: string, nodes: PovNode[]): { povNodes: PovNode[]; situationNodes: unknown[]; nodeEmbeddings: Record<string, unknown> } {
  const nodeEmbeddings: Record<string, unknown> = {};
  for (const n of nodes) nodeEmbeddings[n.id] = { pov: povFile, vector: [1, 0, 0] };
  return { povNodes: nodes, situationNodes: [], nodeEmbeddings };
}

describe('t/4256 — server-built grounding taxonomy through the real buildGroundingEnvelope', () => {
  const taggedSkpNodes = Array.from({ length: 5 }, (_, i) => makeNode(`skp-tagged-${i}`, ['critical']));
  const untaggedSkpNodes = Array.from({ length: 3 }, (_, i) => makeNode(`skp-plain-${i}`));

  beforeEach(() => {
    h.corpora.clear();
    h.capturedDeps = null;
    h.corpora.set('accelerationist', corpusFor('accelerationist', [makeNode('acc-n1'), makeNode('acc-n2')]));
    h.corpora.set('safetyist', corpusFor('safetyist', [makeNode('saf-n1'), makeNode('saf-n2')]));
    h.corpora.set('skeptic', corpusFor('skeptic', [...taggedSkpNodes, ...untaggedSkpNodes]));
    h.corpora.set('cross-cutting', corpusFor('cross-cutting', [makeNode('cc-n1')]));
  });

  async function buildRealTaxonomy() {
    await buildInquiryRunPipeline()(REQUEST, CTX);
    return h.capturedDeps!.taxonomy;
  }

  // FAULT ARM (t/4253): on origin/main before t/4255, isCamp('accelerationist') etc. is false
  // against VALID_CAMPS = {acc,saf,skp,cc}, so every embedding is skipped and nodesByCamp comes
  // back empty for every camp. Run this test against the pre-fix tree to confirm it fails here.
  it('nodesByCamp.acc, .saf and .skp are non-empty for the real, server-built taxonomy', async () => {
    const taxonomy = await buildRealTaxonomy();
    const { envelope } = await buildGroundingEnvelope('any question', taxonomy, fakeEmbed);
    expect(envelope.nodesByCamp.acc ?? []).not.toHaveLength(0);
    expect(envelope.nodesByCamp.saf ?? []).not.toHaveLength(0);
    expect(envelope.nodesByCamp.skp ?? []).not.toHaveLength(0);
  });

  it('with tagSelection {skeptic, critical, scope}: appliedTag is set, and only tagged skp nodes are returned', async () => {
    const taxonomy = await buildRealTaxonomy();
    const { envelope, appliedTag } = await buildGroundingEnvelope('any question', taxonomy, fakeEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' },
    });
    expect(appliedTag).toEqual(expect.objectContaining({ pov: 'skeptic', tag: 'critical', mode: 'scope' }));
    const taggedIds = new Set(taggedSkpNodes.map(n => n.id));
    const skpRefs = envelope.nodesByCamp.skp ?? [];
    expect(skpRefs.length).toBeGreaterThan(0);
    for (const ref of skpRefs) expect(taggedIds.has(ref.nodeId)).toBe(true);
  });
});
