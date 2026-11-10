// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Tests for inquiry debate anchoring to user's question (t/284).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInquiryPipeline } from './inquiryPipeline.js';
import type { InquiryRequest, Fidelity } from '../inquiry/schema.js';
import type { InquiryPipelineDeps } from './inquiryPipeline.js';
import type { DebateSession } from './types/session.js';
import type { GroundingEnvelope } from '../inquiry/schema.js';
import { ActionableError } from './errors.js';

describe('Inquiry Pipeline - Anchor to Question (t/284)', () => {
  let mockDeps: Partial<InquiryPipelineDeps>;
  const testQuestion = 'Should AI development be regulated?';

  beforeEach(() => {
    // Mock taxonomy with basic structure
    const mockTaxonomy = {
      nodeEmbeddings: {},
      accelerationist: { nodes: [] },
      safetyist: { nodes: [] },
      skeptic: { nodes: [] },
      situations: { nodes: [] },
    };

    // Mock adapter
    const mockAdapter = {
      generateText: vi.fn().async().mockResolvedValue(JSON.stringify({
        campVerdicts: [],
        convergences: [],
        evidenceLayers: [],
        unresolvedGaps: [],
      })),
    };

    // Mock embedding function
    const mockEmbed = vi.fn().async().mockResolvedValue([[0.1, 0.2, 0.3]]);

    // Mock registry
    const mockRegistry = {
      models: [
        { id: 'claude-opus', tier: 'advanced', backend: 'claude' },
        { id: 'gemini-2-flash', tier: 'basic', backend: 'gemini' },
      ],
      debateTiers: {
        basic: { gemini: 'gemini-2-flash', claude: 'claude-opus' },
        advanced: { claude: 'claude-opus' },
      },
    };

    // Mock debate session - topic anchored to question
    const mockSession: DebateSession = {
      id: 'test-session-1',
      title: testQuestion,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      phase: 'closed',
      topic: {
        original: testQuestion,
        refined: null,
        final: testQuestion,  // KEY: topic.final === request.question
      },
      source_type: 'topic',
      source_ref: '',
      source_content: '',
      active_povers: ['accelerationist', 'safetyist', 'skeptic'],
      user_is_pover: false,
      transcript: [],
      context_summaries: [],
    };

    // Mock runDebate that returns session with anchored topic
    const mockRunDebate = vi.fn().async().mockResolvedValue({
      session: mockSession,
      terminationReason: undefined,
    });

    mockDeps = {
      registry: mockRegistry as any,
      taxonomy: mockTaxonomy as any,
      embed: mockEmbed,
      adapter: mockAdapter as any,
      runDebate: mockRunDebate,
      onStage: vi.fn(),
    };
  });

  it('accepts debate when topic.final === request.question (anchor intact)', async () => {
    const request: InquiryRequest = {
      question: testQuestion,
      fidelity: 'quick' as Fidelity,
    };

    // Should not throw - topic is anchored
    const result = await runInquiryPipeline(request, mockDeps as InquiryPipelineDeps);
    expect(result).toBeDefined();
  });

  it('throws ActionableError when topic.final drifts from request.question', async () => {
    const request: InquiryRequest = {
      question: testQuestion,
      fidelity: 'quick' as Fidelity,
    };

    // Mock a debate that drifted the topic
    const driftedSession: DebateSession = {
      id: 'test-session-2',
      title: testQuestion,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      phase: 'closed',
      topic: {
        original: testQuestion,
        refined: null,
        final: 'Some completely different topic',  // DRIFT: topic.final !== request.question
      },
      source_type: 'topic',
      source_ref: '',
      source_content: '',
      active_povers: ['accelerationist', 'safetyist', 'skeptic'],
      user_is_pover: false,
      transcript: [],
      context_summaries: [],
    };

    const mockRunDebate = vi.fn().async().mockResolvedValue({
      session: driftedSession,
      terminationReason: undefined,
    });

    mockDeps.runDebate = mockRunDebate;

    // Should throw
    await expect(
      runInquiryPipeline(request, mockDeps as InquiryPipelineDeps),
    ).rejects.toThrow(ActionableError);
  });
});
