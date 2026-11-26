// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

// t/716: a body whose `texts` element was itself an array reached the tokenizer and surfaced as a 500
// with no cause. These tests cover the input check and its use at the worker entry point and in the
// fallback chain.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recorded: { level?: string; message?: string; data?: Record<string, unknown> }[] = [];
vi.mock('../flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (e: never) => { recorded.push(e); } }),
}));

import { ActionableError } from '../debate/errors.js';
import { assertEmbeddingTexts, INVALID_EMBEDDING_INPUT_CODE } from './embeddingInput.js';
import {
  computeEmbeddingsOffThread,
  shutdownEmbeddingWorker,
  isWorkerPoolShedError,
  __setEmbeddingWorkerFactory,
  __resetEmbeddingWorkerForTests,
  type EmbeddingWorkerLike,
} from './offThreadEmbedding.js';
import { resolveEmbeddings, type EmbeddingFallback } from './embeddingResolver.js';

// The smoke probe's body shape (t/716): four texts wrapped twice, so the batch is ONE element, an array.
const PROBE_SHAPE = [['smoke-probe:skp-beliefs-001', 'smoke-probe:sit-001', 'smoke-probe:acc-desires-001', 'smoke-probe:saf-desires-001']];

const caught = (fn: () => void): ActionableError => {
  try { fn(); } catch (e) { return e as ActionableError; }
  throw new Error('expected a throw');
};

describe('assertEmbeddingTexts', () => {
  it('accepts a flat array of strings, an empty array and an empty string', () => {
    expect(() => assertEmbeddingTexts(['a', 'b'], 'here')).not.toThrow();
    expect(() => assertEmbeddingTexts([], 'here')).not.toThrow();
    expect(() => assertEmbeddingTexts([''], 'here')).not.toThrow();
  });

  it('refuses the doubly wrapped array, naming the element and its type', () => {
    const err = caught(() => assertEmbeddingTexts(PROBE_SHAPE, 'here'));
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.code).toBe(INVALID_EMBEDDING_INPUT_CODE);
    expect(err.problem).toBe('texts[0] must be a string, got array (1 element(s) in the batch)');
    expect(err.location).toBe('here');
  });

  it.each([
    ['a number', ['ok', 123], 'texts[1] must be a string, got number'],
    ['null', [null], 'texts[0] must be a string, got null'],
    ['an object', [{ text: 'x' }], 'texts[0] must be a string, got object'],
    ['undefined', ['a', 'b', undefined], 'texts[2] must be a string, got undefined'],
  ])('refuses %s', (_label, texts, expected) => {
    expect(caught(() => assertEmbeddingTexts(texts, 'here')).problem).toContain(expected);
  });

  it('refuses a value that is not an array at all', () => {
    expect(caught(() => assertEmbeddingTexts('one text', 'here')).problem).toBe('texts must be an array of strings, got string');
    expect(caught(() => assertEmbeddingTexts(undefined, 'here')).code).toBe(INVALID_EMBEDDING_INPUT_CODE);
  });
});

describe('computeEmbeddingsOffThread refuses a non-string text before the worker (t/716)', () => {
  class NeverCalledWorker implements EmbeddingWorkerLike {
    posted = 0;
    postMessage(): void { this.posted++; }
    on(): void { /* no events */ }
    terminate(): void { /* nothing to stop */ }
  }
  let spawned: NeverCalledWorker[] = [];

  beforeEach(() => {
    recorded.length = 0;
    spawned = [];
    __resetEmbeddingWorkerForTests();
    __setEmbeddingWorkerFactory(() => { const w = new NeverCalledWorker(); spawned.push(w); return w; });
  });
  afterEach(() => {
    __setEmbeddingWorkerFactory(null);
    shutdownEmbeddingWorker();
  });

  it('rejects the probe shape with the coded error, spawns no worker and posts nothing', async () => {
    const err = await computeEmbeddingsOffThread(PROBE_SHAPE as unknown as string[], { requester: 'smoke' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as ActionableError,
    );
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.code).toBe(INVALID_EMBEDDING_INPUT_CODE);
    expect(err.problem).toContain('texts[0] must be a string, got array');
    expect(isWorkerPoolShedError(err)).toBe(false); // a bad request, not a load-shed
    expect(spawned.length).toBe(0);
  });

  it('records a WARN naming the requester', async () => {
    await computeEmbeddingsOffThread([42] as unknown as string[], { requester: 'smoke' }).catch(() => {});
    const warn = recorded.find(r => r.level === 'warn' && /not an array of strings/.test(r.message ?? ''));
    expect(warn?.data?.requester).toBe('smoke');
  });

  it('still dispatches a valid batch to the worker', () => {
    void computeEmbeddingsOffThread(['a real text'], { requester: 'ok' }).catch(() => {});
    expect(spawned.length).toBe(1);
    expect(spawned[0].posted).toBe(1);
  });
});

describe('the fallback chain keeps the reason and the code for a refused input (t/716)', () => {
  it('names the bad element in the chain-exhaustion error, which is what the server log line prints', async () => {
    __resetEmbeddingWorkerForTests();
    const chain: EmbeddingFallback[] = [{
      name: 'onnx-batch-worker',
      compute: (t) => computeEmbeddingsOffThread(t, { requester: 'embeddings-compute' }).then(v => v.map(x => Array.from(x))),
    }];
    const err = await resolveEmbeddings(PROBE_SHAPE as unknown as string[], undefined, null, chain).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as ActionableError,
    );
    expect(err.code).toBe(INVALID_EMBEDDING_INPUT_CODE);
    expect(err.problem).toContain('All embedding fallbacks failed (tried: onnx-batch-worker)');
    expect(err.problem).toContain('onnx-batch-worker: texts[0] must be a string, got array');
    expect(String(err)).toContain('texts[0] must be a string, got array');
    shutdownEmbeddingWorker();
  });
});
