// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Server-side assembly of InquiryPipelineDeps (t/3581). The inquiry job runner (t/3578)
// takes an injected pipeline function; this module builds the real one by wiring the
// shared runInquiryPipeline (t/3585) with the server's deps:
//
//   registry  → the model registry (ai-models.json), for deriveDebateConfig
//   embed     → aiBackends.computeEmbeddings (server ONNX, vector-identical to the corpus)
//   taxonomy  → GroundingTaxonomy, assembled from the existing per-pov corpus cache
//               (getAssembledCorpus — the same path /api/relevant-nodes uses; TL steer,
//               t/3581#4). NO second taxonomy loading path.
//   runDebate → runHeadlessDebate (t/3599 shared runner) closed over the server adapter +
//               a LoadedTaxonomy (the debate engine's taxonomy shape, distinct from
//               GroundingTaxonomy), memoized (immutable main-branch data).
//   adapter   → a generateText adapter over the server's key-managed provider path
//               (mirrors createWebOpEdAdapter).
//
// The route (routes/inquiry.ts) is the single production wiring: it calls
// buildInquiryRunPipeline() and hands the result to startInquiryJob's runPipeline. Kept
// as one typed function per TL (t/3578#6).

import type { InquiryRequest, InquiryResult, Camp } from '../../../lib/inquiry/index.js';
import { runInquiryPipeline, type InquiryPipelineDeps, type InquiryStage } from '../../../lib/debate/inquiryPipeline.js';
import type { GroundingTaxonomy } from '../../../lib/debate/inquiryGrounding.js';
import type { NodeEmbeddingMap } from '../../../lib/debate/relevanceSelection.js';
import { runHeadlessDebate } from '../../../lib/debate/headlessRunner.js';
import { resolvePoverInfo } from '../../../lib/debate/soulDocLoader.js';
import { loadTaxonomy, type LoadedTaxonomy } from '../../../lib/debate/taxonomyLoader.js';
import { getProjectRoot } from './config.js';
import type { AIAdapter, GenerateOptions } from '../../../lib/debate/aiAdapter.js';
import type { InquiryPipelineRunner, InquiryPipelineContext } from './inquiryJobs.js';
import { getAssembledCorpus } from './routes/corpusAssemblyCache.js';
import { getModelRegistry } from './ai/aiBackends.js';
import * as ai from './ai/aiBackends.js';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { saveDebateSession } from './storage/debateStore.js';

// Camp code (contract) → taxonomy pov-file name (what readTaxonomyFile/getAssembledCorpus key on).
// GroundingEnvelope.nodesByCamp is a PARTIAL record, so a camp whose file is absent is skipped with a
// WARN (fallback-path logging) rather than failing the whole inquiry.
const CAMP_POV_FILES: Record<Camp, string> = {
  acc: 'accelerationist',
  saf: 'safetyist',
  skp: 'skeptic',
  cc: 'cross-cutting',
};

/**
 * Assemble the grounding taxonomy by merging the per-pov corpus (getAssembledCorpus is per-pov —
 * it reads readTaxonomyFile(pov)). `situationNodes` are pov-independent (read from the shared
 * `situations` file), so they are taken once; `povNodes` and `nodeEmbeddings` are merged across camps.
 */
async function buildGroundingTaxonomy(): Promise<GroundingTaxonomy> {
  const povNodes: GroundingTaxonomy['povNodes'] = [];
  const nodeEmbeddings: NodeEmbeddingMap = {};
  let situationNodes: GroundingTaxonomy['situationNodes'] = [];
  let anyCampLoaded = false;

  for (const povFile of Object.values(CAMP_POV_FILES)) {
    try {
      const corpus = await getAssembledCorpus(povFile);
      povNodes.push(...corpus.povNodes);
      Object.assign(nodeEmbeddings, corpus.nodeEmbeddings);
      if (situationNodes.length === 0) situationNodes = corpus.situationNodes;
      anyCampLoaded = true;
    } catch (err) {
      // A missing/unreadable pov file degrades to skipping that camp's nodes — the envelope is
      // partial over camps by design. WARN so the degradation is visible (root AGENTS.md).
      log.server.warn({ err, povFile, cause: 'inquiry-grounding-camp-unreadable' },
        `Skipping camp '${povFile}' in grounding taxonomy — corpus unreadable (t/3581)`);
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'warn',
        message: `Grounding taxonomy: camp '${povFile}' corpus unreadable — skipped`,
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
    }
  }
  if (!anyCampLoaded) {
    // Every camp failed — the pipeline's ADR-001 grounding stage will produce an empty-but-valid
    // envelope from this, and buildGroundingEnvelope logs its own WARN. Surface it here too.
    log.server.warn({ cause: 'inquiry-grounding-empty' },
      'Grounding taxonomy is empty — no camp corpus could be read (t/3581)');
  }
  return { povNodes, situationNodes, nodeEmbeddings };
}

// LoadedTaxonomy (the DEBATE ENGINE's taxonomy shape — distinct from GroundingTaxonomy) is a
// synchronous full-taxonomy filesystem read. Main-branch taxonomy is immutable at runtime (same
// rationale as corpusAssemblyCache), so memoize it process-wide rather than re-reading per inquiry.
let _loadedTaxonomy: LoadedTaxonomy | null = null;
function getLoadedTaxonomy(): LoadedTaxonomy {
  if (_loadedTaxonomy === null) {
    _loadedTaxonomy = loadTaxonomy(getProjectRoot());
    // t/4289/t/4290 AC3: embeddings.json is a precomputed deploy asset (corpusAssemblyCache.ts) —
    // whether it actually shipped non-empty in a given container image is an infra fact, not
    // something this process can assert, only report. hasEmbeddings also gates relevance scoring
    // (per the ticket), so a 0 here degrades the SAME way a missing computeQueryEmbedding did.
    const embeddingCount = Object.keys(_loadedTaxonomy.embeddings).length;
    if (embeddingCount === 0) {
      log.server.warn({ embeddingCount }, 'getLoadedTaxonomy: embeddings.json loaded with zero entries — relevance scoring will degrade (t/4289/t/4290)');
    } else {
      log.server.info({ embeddingCount }, 'getLoadedTaxonomy: taxonomy loaded');
    }
  }
  return _loadedTaxonomy;
}

/** The server inquiry AIAdapter — generateText over the key-managed, fallback-chained provider path,
 *  so the container never holds a raw key (mirrors createWebOpEdAdapter). native fact-check search
 *  (ExtendedAIAdapter) is not wired for v1.
 *  t/4289/t/4290: computeQueryEmbedding was missing, so every inquiry run fell back to lexical
 *  relevance (taxonomyContext.ts), skipped claim attribution, and skipped turn embeddings for
 *  convergence — all three gate on this adapter member being present, not just generateText. Wired
 *  to the same cached query-embedding path routes/relevantNodes.ts already uses (384-dim MiniLM).
 *  Errors are NOT swallowed here — the engine already catches and falls back with a WARN. */
function createInquiryAdapter(): AIAdapter {
  return {
    async generateText(prompt: string, model: string, options?: GenerateOptions): Promise<string> {
      const result = await ai.generateText(prompt, model, undefined, options?.timeoutMs, undefined, {
        temperature: options?.temperature,
        signal: options?.signal,
        responseSchema: options?.responseSchema,
        maxTokens: options?.maxTokens,
      });
      return result.text;
    },
    async computeQueryEmbedding(text: string): Promise<{ vector: number[] }> {
      return { vector: await ai.computeQueryEmbedding(text) };
    },
    // t/3614: required AIAdapter member — host-loaded registry data (cached via getModelRegistry),
    // the same source buildInquiryRunPipeline uses for deps.registry below.
    registry: getModelRegistry(),
  };
}

/**
 * t/4338: persist the inquiry's underlying headless debate session so `result.debateId`
 * (stamped from `session.id`, t/3641) resolves to something — before this, `runHeadlessDebate`
 * never persisted anything, so "View raw run" (t/3617) 404'd for every inquiry answer ever
 * produced. CL + TL decision (t/4338#2/#3): persist, quota-exempt (an inquiry debate is an
 * implementation detail of answering the inquiry, not a user-initiated debate — counting it
 * against debate quota would be a cost-model change, PI-only), marked with its origin so it
 * can be told apart from interactive debates in listings/counts. `mustNotExist: true` (t/4331)
 * makes this a true create — a fresh `session.id`, one writer — and skips the "missing
 * expectedVersion" WARN that tracks un-migrated UPDATE callers, not legitimate creates.
 * `excludeFromQuota: true` (t/4331, CL review on #3511) is what actually makes this
 * quota-exempt: it stores under `inquiry-debate-<id>.json`, a prefix the quota count and
 * the debate listing both skip structurally — `mustNotExist` alone does not exempt a save
 * from the quota (that was CL's finding: the first pass used the plain `debate-<id>.json`
 * path, which the quota counts regardless of any other opt). `loadDebateSession` still
 * finds it via a fallback, so "View raw run" is unaffected.
 *
 * Never lets a save failure break the inquiry answer itself: the result is the user-facing
 * artifact, the debate is an audit copy. A failed save just means "View raw run" 404s for this
 * one result, same as it always has — logged, not silently swallowed.
 */
async function persistInquiryDebateSession(session: unknown, jobId: string): Promise<void> {
  const marked = { ...(session as object), origin: { mode: 'inquiry', inquiry_id: jobId } };
  try {
    await saveDebateSession(marked, 'inquiry', { mustNotExist: true, listedButExempt: true });
  } catch (err) {
    log.server.warn({ err, jobId }, 'Failed to persist inquiry debate session — "View raw run" will 404 for this result (t/4338)');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'inquiry', level: 'warn',
      message: `Failed to persist inquiry debate session for job ${jobId}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Build the single injected pipeline runner the job store (t/3578) calls. Assembles the server deps
 *  and adapts runInquiryPipeline to the InquiryPipelineRunner signature (request + ctx → InquiryResult).
 *  `ctx.onStage` (job progress) is mapped onto the pipeline's InquiryStage sink. */
export function buildInquiryRunPipeline(): InquiryPipelineRunner {
  const adapter = createInquiryAdapter();
  return async (request: InquiryRequest, ctx: InquiryPipelineContext): Promise<InquiryResult> => {
    const taxonomy = await buildGroundingTaxonomy();
    const deps: InquiryPipelineDeps = {
      registry: getModelRegistry(),
      taxonomy,
      embed: (texts: string[]) => ai.computeEmbeddings(texts, undefined, undefined, { requester: 'inquiry' }).then(r => r.vectors),
      // runHeadlessDebate takes the config (which already carries the question via deriveDebateConfig)
      // + the engine's LoadedTaxonomy; the pipeline's `question` arg is unused here.
      // t/4025: inject soulResolver so server inquiry debates record soul_provenance.
      runDebate: (config, _question) => runHeadlessDebate({ ...config, soulResolver: resolvePoverInfo }, adapter, getLoadedTaxonomy())
        .then(async (r) => {
          await persistInquiryDebateSession(r.session, ctx.jobId); // t/4338
          return { session: r.session, terminationReason: r.terminationReason };
        }),
      adapter,
      onStage: (stage: InquiryStage) => mapStage(stage, ctx),
    };
    return runInquiryPipeline(request, deps);
  };
}

/** Map the pipeline's stage vocabulary onto the job store's progress stages. The job store
 *  (InquiryPipelineStage) uses grounding/debating/judging/synthesizing; the pipeline emits
 *  deriving/grounding/debating/projecting/synthesizing. Fold deriving→grounding and
 *  projecting→judging so the job's coarser progress bar advances sensibly. */
function mapStage(stage: InquiryStage, ctx: InquiryPipelineContext): void {
  switch (stage) {
    case 'deriving':
    case 'grounding': ctx.onStage('grounding'); return;
    case 'debating': ctx.onStage('debating'); return;
    case 'projecting': ctx.onStage('judging'); return;
    case 'synthesizing': ctx.onStage('synthesizing'); return;
    default: { const _x: never = stage; void _x; }
  }
}
