// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/284 item 4: named entities in the question are carried into scope.explicit_qualifiers, so
// the alignment gate's TOPIC_ALIGNED check sees them. Gated on anchorToResolution.

import { describe, it, expect, vi } from 'vitest';
import { TopicPipeline, extractQuestionEntities } from './topicPipeline.js';

describe('extractQuestionEntities (t/284 item 4)', () => {
  it('takes capitalised tokens that are not the first word of a sentence', () => {
    expect(extractQuestionEntities('Will the policy in China slow AI? Does the EU matter?'))
      .toEqual(['China', 'AI', 'EU']); // AI is kept: the rule has no acronym stoplist
  });

  it('takes quoted phrases and drops duplicates', () => {
    expect(extractQuestionEntities('Is "open weights" risky for Anthropic and Anthropic users?'))
      .toEqual(['open weights', 'Anthropic']);
  });

  it('ignores a capitalised first word of a sentence', () => {
    expect(extractQuestionEntities('Should regulation slow progress?')).toEqual([]);
  });
});

function pipelineWith(scopeQualifiers: string[] | undefined, anchorToResolution: boolean, question: string) {
  const session = {
    topic: { original: question, refined: null, final: question, scope: scopeQualifiers === undefined ? undefined : { explicit_qualifiers: [...scopeQualifiers] } },
    transcript: [],
  };
  const ctx = {
    session,
    config: { anchorToResolution },
    adapter: {},
    taxonomy: {},
    generate: vi.fn().mockResolvedValue('{"clauses": []}'),
    progress: vi.fn(),
    warn: vi.fn(),
    addEntry: vi.fn(),
  };
  return { pipeline: new TopicPipeline(ctx as never), session };
}

describe('TopicPipeline.runResolutionAnchoring — entities into scope (t/284 item 4)', () => {
  it('merges question entities into scope.explicit_qualifiers when anchorToResolution is on', async () => {
    const { pipeline, session } = pipelineWith(['existing'], true, 'Does the policy in China slow AI?');
    await pipeline.runResolutionAnchoring();
    expect(session.topic.entities).toEqual(['China', 'AI']);
    expect(session.topic.scope?.explicit_qualifiers).toEqual(['existing', 'China', 'AI']);
  });

  it('leaves scope untouched when anchorToResolution is off (normal debates)', async () => {
    const { pipeline, session } = pipelineWith(['existing'], false, 'Does the policy in China slow AI?');
    await pipeline.runResolutionAnchoring();
    expect(session.topic.entities).toBeUndefined();
    expect(session.topic.scope?.explicit_qualifiers).toEqual(['existing']);
  });
});
