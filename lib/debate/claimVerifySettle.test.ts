// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression test for t/1781 fix (a): the post-completion settle-gate that waits
// for the fire-and-forget evidence verifications (verifyPreciseClaims — which
// populate evidence_graph.evidence_items, the source-authority substrate) to
// settle BEFORE the end-of-debate calibration extract. Without the gate the
// verification races the extract, yielding a non-deterministic null
// source_authority. This test proves the extract observes a settled substrate:
// the verification's evidence is present at extract time, so source_authority is
// deterministically non-null.
//
// The extract is stubbed here (its real body reads a full neutral evaluation the
// trivial mock adapter does not produce — an unrelated concern). The stub
// reproduces exactly what the real extract does for source authority: it calls
// the real computeSourceAuthority on session.argument_network.nodes + docMeta,
// captured at the moment extract runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceAuthorityResult } from './sourceAuthority.js';

let capturedSourceAuthority: SourceAuthorityResult | null = null;
let capturedHasEvidenceNode = false;

vi.mock('./calibrationLogger.js', async (importActual) => {
  const actual = await importActual<typeof import('./calibrationLogger.js')>();
  const { computeSourceAuthority } = await import('./sourceAuthority.js');
  return {
    ...actual,
    appendCalibrationLog: vi.fn(),
    // Stub extract: capture the source-authority substrate present at the exact
    // moment the completion path invokes it, computed exactly as the real extract
    // does (computeSourceAuthority over the AN nodes + docMeta).
    extractCalibrationData: vi.fn((session: any, _origin: string, opts?: any) => {
      const nodes = session.argument_network?.nodes ?? [];
      capturedHasEvidenceNode = nodes.some((n: any) => n?.evidence_graph?.evidence_items?.length);
      capturedSourceAuthority = computeSourceAuthority(nodes, opts?.docMeta ?? session.doc_meta);
      return {} as any; // downstream only sets coherence_gate_miss + appendCalibrationLog (mocked)
    }),
  };
});

import { DebateEngine } from './debateEngine.js';
import type { DebateConfig } from './debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from './aiAdapter.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';
import { extractCalibrationData } from './calibrationLogger.js';

const extractSpy = vi.mocked(extractCalibrationData);

function createMockAdapter(): ExtendedAIAdapter {
  return {
    async generateText(_prompt: string, _model: string, _options?: GenerateOptions) {
      return '{"response": "mock"}';
    },
    registry: { backends: [], models: [] },
  };
}

function createMinimalTaxonomy(): LoadedTaxonomy {
  return {
    accelerationist: { nodes: [{ id: 'acc-B-001', label: 'AI progress is net positive', description: 'Technology advances benefit society', category: 'beliefs' } as any] },
    safetyist: { nodes: [{ id: 'saf-B-001', label: 'AI poses existential risk', description: 'Advanced AI could be dangerous', category: 'beliefs' } as any] },
    skeptic: { nodes: [{ id: 'skp-B-001', label: 'AI hype is overblown', description: 'Current AI capabilities are limited', category: 'beliefs' } as any] },
    situations: { nodes: [] },
    edges: null,
    embeddings: {},
    policyRegistry: [],
    allNodesById: new Map(),
    resolveNode: (_id: string) => undefined,
    selectableEdges: null,
  };
}

function createConfig(overrides: Partial<DebateConfig> = {}): DebateConfig {
  return {
    topic: 'Should AI development be regulated?',
    sourceType: 'topic',
    activePovers: ['accelerationist', 'safetyist', 'skeptic'],
    model: 'gemini-2.0-flash',
    rounds: 2,
    responseLength: 'short',
    ...overrides,
  };
}

describe('t/1781 calibration settle-gate', () => {
  beforeEach(() => {
    extractSpy.mockClear();
    capturedSourceAuthority = null;
    capturedHasEvidenceNode = false;
  });

  // 20s timeout: this drives a full engine.run() + the post-completion settle-gate; the
  // vitest 5s default flakes under the parallel taxonomy-editor verify load (t/1729 land).
  it('extract observes settled evidence → source_authority deterministically non-null', { timeout: 20_000 }, async () => {
    const engine = new DebateEngine(createConfig(), createMockAdapter(), createMinimalTaxonomy());

    // Deterministic doc metadata → source_authority resolves once evidence exists.
    (engine as any)._docTitles = { docA: { title: 'Nature Medicine 2024 study on AI' } };

    // Model a still-in-flight evidence verification: a promise that does NOT settle
    // until released, and which — like the real verifyPreciseClaims — populates
    // evidence_graph.evidence_items on an argument-network node when it settles.
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((res) => { releaseVerify = res; });
    const pending = verifyGate.then(() => {
      const session = (engine as any).session;
      session.argument_network ??= { nodes: [], edges: [] };
      session.argument_network.nodes.push({
        id: 'acc-B-900',
        label: 'Precise verified claim',
        text: 'A precise, evidence-backed belief',
        category: 'beliefs',
        speaker: 'document', // excluded from agent-utility; still counts for source authority
        pov: 'accelerationist',
        base_strength: 0.7,
        evidence_graph: {
          evidence_items: [
            { id: 'e1', source_doc_id: 'docA', text: 'supporting evidence', relation: 'support' as const, similarity: 0.9 },
          ],
        },
      } as any);
    });

    // Seed the pending verification exactly as the engine's call sites do.
    (engine as any)._pendingClaimVerifications.push(pending);

    const runPromise = engine.run();

    // Release the verification only well after the debate would otherwise have
    // completed. Absent the settle-gate, the extract would already have run against
    // an empty substrate (null source_authority). With the gate, run() blocks on the
    // pending verification until this fires, so extract observes the evidence.
    const timer = setTimeout(() => releaseVerify(), 800);
    await runPromise;
    clearTimeout(timer);
    releaseVerify(); // idempotent no-op if already released

    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(capturedHasEvidenceNode, 'evidence must be present in the AN at extract time').toBe(true);
    expect(capturedSourceAuthority).not.toBeNull();
    expect(capturedSourceAuthority!.source_authority_mean).not.toBeNull();
    expect(capturedSourceAuthority!.source_authority_mean!).toBeGreaterThan(0);
  });
});
