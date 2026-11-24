// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/414: the synthetic-arm control-fallback paths must emit a WARN through the flight recorder,
// naming the debate and the reason. Recorder spy, so the record is asserted, not assumed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recorder = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('../../flight-recorder/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../flight-recorder/index.js')>()),
  getGlobalRecorder: () => recorder,
}));

import { resolveSyntheticPromptNodes } from './taxonomyContext.js';
import type { DebateEngineInternals } from './internals.js';
import type { PovNode } from '../taxonomyTypes.js';

const node = (id: string, category: string): PovNode =>
  ({ id, category, label: id, description: `DOLCE ${id}`, graph_attributes: {} }) as unknown as PovNode;

function engine(config: Record<string, boolean>, vectors: Record<string, { vectors?: number[][] }>, statements: Record<string, string[]>): DebateEngineInternals {
  return {
    config,
    session: { id: 'debate-t414' },
    taxonomy: { embeddings: vectors, syntheticStatements: statements },
  } as unknown as DebateEngineInternals;
}

const QUERY = [1, 0];

describe('synthetic-arm control-fallback WARN (t/414)', () => {
  beforeEach(() => {
    recorder.record.mockClear();
  });

  it('emits a WARN naming the debate and the no-query-embedding reason', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, { 'acc-data-001': ['stmt'] });
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map(), null);
    expect(r).toEqual({ arm: 'control-fallback' });
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.error',
      component: 'debate-engine',
      level: 'warn',
      debate_id: 'debate-t414',
      message: expect.stringContaining('no query embedding'),
    }));
    expect(recorder.record.mock.calls[0][0].message).toContain('synthetic_arm=control-fallback');
  });

  it('emits a WARN naming the debate and the zero-node reason when nothing survives', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, {});
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map([['acc-data-001', 0.9]]), QUERY);
    expect(r).toEqual({ arm: 'control-fallback' });
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      debate_id: 'debate-t414',
      message: expect.stringContaining('no POV node has a usable synthetic statement'),
    }));
  });

  it('emits no control-fallback WARN when the synthetic arm runs', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, { 'acc-data-001': ['stmt'] });
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map(), QUERY);
    expect(r?.arm).toBe('synthetic');
    const fallbackWarns = recorder.record.mock.calls.filter(c => String(c[0].message).includes('control-fallback'));
    expect(fallbackWarns).toEqual([]);
  });
});
