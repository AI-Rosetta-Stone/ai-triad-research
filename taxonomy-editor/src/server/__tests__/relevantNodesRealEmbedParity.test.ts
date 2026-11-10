// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3258 (T3) — REAL-EMBED PARITY CAPTURE (the load-bearing gate before the client flip; TL GV,
// t/3257#28). This is the belt against the t/3165 fixture≠prod trap that the hash-stub fixture
// (relevantNodesParity.test.ts) cannot provide: it runs the DIFFERENTIAL on a REAL debate with REAL
// ONNX embeddings, exercising the AN-claim PRIMARY path (real argument_network embeddings), not the
// topic-query fallback.
//
//   A = POST /api/taxonomy/relevant-nodes (the endpoint, server-side assembly + real ai.* ONNX).
//   B = the pre-#1922 CLIENT-LOCAL selection, reproduced field-for-field from taxonomyContext.ts
//       (buildNodeEmbeddingMap → assembleNodeEmbeddings + selectRelevantTaxonomy) using the SAME
//       real ai.* ONNX — which is exactly where the web-bridge client's api.computeEmbeddings /
//       api.computeQueryEmbedding land (same process, same ONNX binary; the #18 same-backend proof
//       TL accepted for (a)). So B is a faithful stand-in for the web client's local computation.
//
// Both are fed the IDENTICAL real debate state (pov, topic, recentTranscript, session incl. real
// anClaimEmbeddings). Assertion: order-preserving node+order equality on povNodes/situationNodes,
// EXACT scores (ONNX is deterministic — no tolerance), >0 nodes selected, provenance passthrough.
// Divergence = FAIL. This proves the T3 endpoint produces exactly what the client computes locally
// on real data + real embeddings; it does NOT exercise the literal REST hop (that rests on #18) or a
// live deployment.
//
// B must mirror every candidate filter the client applies; t/4926 found it missing the t/4433
// supersession filter, which surfaced as a nodeSourceMap count mismatch once real data carried
// superseded nodes.
//
// CI-safe: skipIf the data root / debate fixture is absent (CI has neither → skips). Run locally with
// the real data root to capture the GV evidence: `npx vitest run src/server/__tests__/relevantNodesRealEmbedParity.test.ts`.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

import { registerRelevantNodesRoutes } from '../routes/relevantNodes.js';
import {
  selectRelevantTaxonomy,
  assembleNodeEmbeddings,
  type ANClaimInput,
  type SelectRelevantTaxonomyInput,
} from '../../../../lib/debate/relevanceSelection.js';
import { POVER_INFO, getPovDoctrinalBoundaries } from '../../../../lib/debate/poverInfo.js';
import { buildSupersessionIndex } from '../../../../lib/debate/supersession.js';
import * as fileIO from '../storage/fileIO.js';
import * as ai from '../ai/aiBackends.js';
import type { ServerCtx } from '../routes/context.js';

// ── Fixture selection: a real topic-source debate with a populated argument_network (real 384-dim
// AN-claim embeddings → the PRIMARY scoring path). Guard on presence so CI (no data root) skips. ──
const DATA_ROOT = process.env.AI_TRIAD_DATA_ROOT;
const DEBATE_FILE = 'debate-2306fafc-6d5e-4387-beee-f1ecc900b7ce.json';
const DEBATE_PATH = DATA_ROOT ? path.join(DATA_ROOT, 'debates', DEBATE_FILE) : '';
const POV = 'accelerationist';
const THRESHOLD = 0.45; // the client's default (getRelevantTaxonomyContext), same for A and B.
const HARNESS_READY = !!DATA_ROOT && !!DEBATE_PATH && fs.existsSync(DEBATE_PATH);

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}
function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _status: 200, _body: undefined,
    writeHead: (c: number) => { res._status = c; res.headersSent = true; },
    end: (b?: string) => { res._body = b !== undefined ? JSON.parse(b as string) : undefined; res.writableEnded = true; },
    setHeader: () => {},
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _status: number };
}
const fakeReq = () => ({ url: '/api/taxonomy/relevant-nodes', method: 'POST' } as unknown as IncomingMessage);

/** Map loadSyntheticEmbeddings() ({pov,vectors}) → the {nodeId: vectors[][]} shape assembleNodeEmbeddings wants
 *  — identical to relevantNodes.ts synthVectorsForAssembly (so B assembles the corpus exactly as the client does). */
function synthForAssembly(synth: Record<string, { pov: string; vectors: number[][] }> | null): Record<string, number[][]> | null {
  if (!synth) return null;
  const out: Record<string, number[][]> = {};
  for (const [nodeId, entry] of Object.entries(synth)) out[nodeId] = entry.vectors;
  return out;
}

/** Pick the first string-valued topic representation; content is irrelevant to parity (A and B get the
 *  same string) — it only needs to be a real topic so the topic-query embed is non-degenerate. */
function extractTopic(debate: Record<string, unknown>): string {
  const t = debate.topic as Record<string, unknown> | undefined;
  for (const k of ['final', 'refined', 'original', 'rewritten_topic'] as const) {
    const v = t?.[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object' && typeof (v as { text?: string }).text === 'string') return (v as { text: string }).text;
  }
  return typeof debate.title === 'string' ? debate.title : 'AI policy';
}

/** Join the last few transcript turns into a recentTranscript string (again, identical for A and B). */
function extractRecentTranscript(debate: Record<string, unknown>): string {
  const tr = debate.transcript;
  if (!Array.isArray(tr)) return '';
  const texts: string[] = [];
  for (const turn of tr.slice(-4)) {
    const s = (turn && typeof turn === 'object')
      ? ((turn as { text?: string; content?: string; message?: string }).text
        ?? (turn as { content?: string }).content
        ?? (turn as { message?: string }).message)
      : undefined;
    if (typeof s === 'string' && s.trim()) texts.push(s);
  }
  return texts.join('\n\n');
}

describe.skipIf(!HARNESS_READY)('POST /api/taxonomy/relevant-nodes — REAL-embed parity capture (t/3258 T3, TL GV)', () => {
  it('endpoint (A) === client-local selection (B) on a real AN-claim debate — order-preserving, exact scores, >0 nodes', async () => {
    const debate = JSON.parse(fs.readFileSync(DEBATE_PATH, 'utf-8')) as Record<string, unknown>;

    // ── Real debate state, IDENTICAL for A and B (mirrors getRelevantTaxonomyContext's assembly) ──
    const anNodes = ((debate.argument_network as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<{
      id: string; embedding?: number[]; computed_strength?: number; text?: string;
    }>;
    const anClaimEmbeddings: ANClaimInput[] = anNodes
      .filter(n => Array.isArray(n.embedding) && n.embedding.length > 0)
      .map(n => ({ id: n.id, vector: n.embedding!, strength: n.computed_strength as number, text: n.text }));
    const lineageFrame = (debate.topic as { critique?: { lineage_frame?: { cluster_id: string; label?: string }[] } } | undefined)
      ?.critique?.lineage_frame;
    const sourceType = debate.source_type as string | undefined;
    const excludeGreatestHits = !!debate.exclude_greatest_hits;
    const greatestHitsList = excludeGreatestHits ? [] : undefined;
    const topic = extractTopic(debate);
    const recentTranscript = extractRecentTranscript(debate);
    const session = { anClaimEmbeddings, lineageFrame, sourceType, excludeGreatestHits, greatestHitsList };
    const params = { pov: POV, topic, recentTranscript, threshold: THRESHOLD };

    // Sanity: this must exercise the PRIMARY path with GENUINE 384-dim vectors, not stubs/fallback.
    expect(anClaimEmbeddings.length, 'debate must carry real AN-claim embeddings (primary path)').toBeGreaterThan(0);
    expect(anClaimEmbeddings[0].vector.length, 'AN-claim vectors must be genuine 384-dim ONNX, not stubs').toBe(384);
    expect(sourceType, 'topic-source debate exercises the AN-claim primary orchestration').toBe('topic');

    // ── A: the endpoint (real fileIO + real ai.* ONNX; NO mocks) ──
    const { router, handlers } = makeRouter();
    registerRelevantNodesRoutes(router as never, {} as ServerCtx);
    const post = handlers['POST /api/taxonomy/relevant-nodes'];
    const res = fakeRes();
    await post(fakeReq(), res, { pov: POV, topic, recentTranscript, threshold: THRESHOLD, session });
    expect(res._status, 'endpoint must 200').toBe(200);
    const A = res._body as SelectRelevantTaxonomyInput extends never ? never : {
      povNodes: { nodeId: string; score: number }[]; situationNodes: { nodeId: string; score: number }[];
      nodeSourceMap: Record<string, unknown>; anchoring: unknown[]; policyRegistry: unknown[];
    };

    // ── B: the pre-#1922 client-local selection, reproduced with the SAME real ai.* ONNX ──
    const povFile = await fileIO.readTaxonomyFile(POV) as { nodes?: SelectRelevantTaxonomyInput['povNodes'] };
    // t/4926 (t/180): superseded nodes are never candidates — the client's loadTaxonomy and the endpoint
    // (corpusAssemblyCache, t/4433) both drop them. Without this, B scored the 4 superseded acc-beliefs nodes
    // and nodeSourceMap came out 687 vs the endpoint's 683.
    const allPovNodes = povFile?.nodes ?? [];
    const { isSuperseded } = buildSupersessionIndex(allPovNodes);
    const povNodes = allPovNodes.filter(n => !isSuperseded(n.id));
    const sitFile = await fileIO.readTaxonomyFile('situations') as { nodes?: SelectRelevantTaxonomyInput['situationNodes'] };
    const situationNodes = sitFile?.nodes ?? [];
    const policyRaw = await fileIO.readPolicyRegistry() as { policies?: { id: string; action: string; source_povs?: string[] }[] } | null;
    const policyRegistry = (policyRaw?.policies ?? []).map(p => ({ id: p.id, action: p.action, source_povs: p.source_povs }));
    const lineageRaw = await fileIO.readLineageCategories() as { mapping?: Record<string, { l2: string }> } | null;
    const lineageMapping = lineageRaw?.mapping;
    const povInfo = Object.values(POVER_INFO).find(i => i.pov === POV);
    const doctrinalBoundaries = povInfo ? getPovDoctrinalBoundaries(povInfo) : undefined;
    // Corpus: batch ai.computeEmbeddings (the web-bridge api.computeEmbeddings destination) + synthetic merge.
    const corpusEmbed = (texts: string[], ids?: string[]) =>
      ai.computeEmbeddings(texts, ids, undefined, { requester: 't3258-parity:corpus' }).then(r => r.vectors);
    const synth = synthForAssembly(await fileIO.loadSyntheticEmbeddings());
    const { nodeEmbeddings } = await assembleNodeEmbeddings(POV, povNodes, situationNodes, corpusEmbed, synth);
    // Boundary + topic-query: per-text ai.computeQueryEmbedding (matches the endpoint + the client role-split, t/3257#25).
    const queryEmbed = (texts: string[]) => Promise.all(texts.map(t => ai.computeQueryEmbedding(t)));
    const B = await selectRelevantTaxonomy({
      povNodes, situationNodes, policyRegistry, nodeEmbeddings, lineageMapping, doctrinalBoundaries,
      session, params, embed: queryEmbed,
    });

    // Corpus vectors must be genuine 384-dim (real embeddings, not the 3-dim hash stub).
    const sampleVec = Object.values(nodeEmbeddings)[0] as { vector: number[] } | undefined;
    expect(sampleVec?.vector.length, 'corpus vectors must be genuine 384-dim').toBe(384);

    // ── Non-trivial: the debate must select >0 nodes (both-empty is the vacuous-pass escape) ──
    expect(A.povNodes.length + A.situationNodes.length, 'endpoint must select >0 nodes').toBeGreaterThan(0);
    expect(B.povNodes.length + B.situationNodes.length, 'client must select >0 nodes').toBeGreaterThan(0);

    // ── The gate: order-preserving node+order equality + EXACT scores (deterministic ONNX) ──
    expect(A.povNodes).toEqual(B.povNodes);               // W3: same nodes, SAME ORDER, exact scores
    expect(A.situationNodes).toEqual(B.situationNodes);
    expect(A.nodeSourceMap).toEqual(B.nodeSourceMap);     // AN-vs-topic provenance identical
    expect(A.anchoring).toEqual(B.anchoring);
    expect(A.policyRegistry).toEqual(B.policyRegistry);

    // Capture evidence for the GV.
    const anBacked = Object.values(B.nodeSourceMap).filter(s => (s as { source?: string }).source === 'an').length;
    console.log(`[t3258-parity] A===B ✓ debate=${DEBATE_FILE} pov=${POV} anClaims=${anClaimEmbeddings.length} ` +
      `selected: pov=${A.povNodes.length} sit=${A.situationNodes.length} an-scored-nodes=${anBacked} ` +
      `topScore=${A.povNodes[0]?.score?.toFixed(6) ?? 'n/a'}`);
  }, 120_000);
});
