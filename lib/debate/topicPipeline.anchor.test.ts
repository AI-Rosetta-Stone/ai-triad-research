// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/284: inquiry anchoring in TopicPipeline.runClarificationPhase and the critique rewrite.

import { describe, it, expect, vi } from 'vitest';
import { TopicPipeline } from './topicPipeline.js';
import type { TopicPipelineContext } from './topicPipeline.js';
import type { DebateSession } from './types.js';

function makeCtx(config: Record<string, unknown>, computeQueryEmbedding = vi.fn().mockResolvedValue({ vector: [0.1, 0.2] })) {
  const session = { topic: { final: 'Should China regulate AI?' } } as unknown as DebateSession;
  const generate = vi.fn().mockResolvedValue(JSON.stringify({ clauses: ['China regulates', 'AI is the object'] }));
  const ctx = {
    session,
    config,
    adapter: { computeQueryEmbedding },
    taxonomy: {} as never,
    generate,
    generateViaUsage: generate,
    generateWithModel: generate,
    resolveStageModel: () => 'm',
    addEntry: (e: object) => ({ ...e, id: 'x', timestamp: 0 }) as never,
    recordDiagnostic: () => {},
    progress: () => {},
    warn: () => {},
  } as unknown as TopicPipelineContext;
  return { ctx, session, generate, computeQueryEmbedding };
}

describe('TopicPipeline.runClarificationPhase (t/284)', () => {
  it('decomposes the question into clauses and embeds anchors when anchorToResolution is set', async () => {
    const { ctx, session, generate } = makeCtx({ anchorToResolution: true });
    await new TopicPipeline(ctx).runClarificationPhase();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(session.topic.clauses).toEqual(['China regulates', 'AI is the object']);
    expect(session.topic.embedding).toEqual([0.1, 0.2]);
    expect(session.topic.clause_embeddings).toHaveLength(2);
  });

  it('does nothing for a normal debate without clarification', async () => {
    const { ctx, session, generate, computeQueryEmbedding } = makeCtx({});
    await new TopicPipeline(ctx).runClarificationPhase();
    expect(generate).not.toHaveBeenCalled();
    expect(computeQueryEmbedding).not.toHaveBeenCalled();
    expect(session.topic.clauses).toBeUndefined();
  });
});
