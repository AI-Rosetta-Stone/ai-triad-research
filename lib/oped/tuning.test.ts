// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/203: the New Op-Ed dialog's Max grounding nodes / Max situations / Temperature / ground toggle reach the
// pipeline through OpEdParams. Each one changes behaviour, absent means today's fixed values, out-of-range is
// clamped with a WARN, and the values used are recorded (set.params, and the temperature on each stage).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const spy = vi.hoisted(() => ({
  loadTaxonomy: vi.fn(),
  nodeMaxTotal: [] as number[],
  sitMinMax: [] as Array<[number, number]>,
  temps: [] as Array<number | undefined>,
}));

const node = (id: string, category: string) => ({ id, category, label: id, description: 'd', parent_id: null, children: [] });
const accNodes = Array.from({ length: 20 }, (_, i) => node(`acc-bel-${String(i).padStart(3, '0')}`, 'Beliefs'));
const sits = Array.from({ length: 10 }, (_, i) => ({ id: `sit-${i}`, label: 'l', description: 'd', parent_id: null }));

vi.mock('../embeddings/onnxEmbedding.js', () => ({ computeEmbedding: async () => [1, 0, 0] }));
vi.mock('../debate/taxonomyLoader.js', () => ({
  loadTaxonomy: (...a: unknown[]) => {
    spy.loadTaxonomy(...a);
    return { accelerationist: { nodes: accNodes }, safetyist: { nodes: [] }, skeptic: { nodes: [] }, situations: { nodes: sits }, embeddings: {} };
  },
}));
vi.mock('../debate/taxonomyRelevance.js', () => ({
  scoreNodeRelevance: () => new Map(),
  // Return EVERY node, ignoring the cap, so the test proves generate.ts enforces it itself.
  selectRelevantNodes: (nodes: { id: string }[], _s: unknown, _t: unknown, _min: number, maxTotal: number) => {
    spy.nodeMaxTotal.push(maxTotal);
    return nodes.map(n => ({ node: n, score: 0.9 }));
  },
  selectRelevantSituationNodes: (nodes: { id: string }[], _s: unknown, _t: unknown, min: number, max: number) => {
    spy.sitMinMax.push([min, max]);
    return nodes.map(n => ({ node: n, score: 0.8 }));
  },
}));
vi.mock('./outletBands.js', () => ({ resolveOutletBand: () => ({ words: 800, guidance: 'g' }) }));
vi.mock('./promptLoader.js', () => ({
  loadAndAssemblePrompt: () => ({ system: 'SYS', user: 'USER' }),
  assembleSourceBriefPrompt: () => 'P:source-brief',
  assembleCoherenceJudgePrompt: () => 'P:judge',
  assembleCoherenceRewritePrompt: () => 'P:rewrite',
  assembleReadabilityEditPrompt: () => 'P:edit',
  assembleReflectionPrompt: () => 'P:reflection',
}));
vi.mock('./coherenceCheck.js', () => ({
  COHERENCE_JUDGE_SCHEMA: {}, normalizeJudgeResult: () => [], validFlags: () => [], buildCoherenceViolationsText: () => '',
}));
vi.mock('./readabilityMeasure.js', async (orig) => ({
  ...(await orig<typeof import('./readabilityMeasure.js')>()),
  needsEdit: () => false,
}));

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateOpEdSet, resolveOpEdTuning, OPED_TUNING_DEFAULTS, type OpEdProgressEvent } from './generate.js';
import { parseOpEdSet } from './schemas.js';
import type { OpEdParams, OpEdSet } from './types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESSAY = JSON.stringify({ headline: 'H', subtitle: 'S', body_markdown: 'Body text that is long enough.', word_count: 6 });

async function run(extra: Partial<OpEdParams> = {}): Promise<{ set: OpEdSet; events: OpEdProgressEvent[]; warns: string[] }> {
  const warns: string[] = [];
  const events: OpEdProgressEvent[] = [];
  const req = {
    set_id: 's1', topic: 'AI policy', povs: ['accelerationist' as const],
    params: { model: 'test-model', wordCount: 800, outlet: 'nyt', newsHook: 'hook', thesis: '', ...extra } as OpEdParams,
  };
  const deps = {
    adapter: {
      generateText: async (p: string, _m: string, o?: { temperature?: number }) => {
        if (p === 'SYS\n\n---\n\nUSER') { spy.temps.push(o?.temperature); return ESSAY; }
        if (p === 'P:judge') return JSON.stringify({});
        return JSON.stringify({ grounding_usage: [], claims: [] });
      },
    } as never,
    promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'),
    repoRoot: REPO_ROOT,
    recorder: { record: (e: { level?: string; message?: string }) => { if (e.level === 'warn') warns.push(String(e.message)); } } as never,
  };
  let set: OpEdSet | undefined;
  for await (const ev of generateOpEdSet(req, deps)) { events.push(ev); if (ev.type === 'complete') set = ev.set; }
  return { set: set!, events, warns };
}

beforeEach(() => { spy.loadTaxonomy.mockClear(); spy.nodeMaxTotal = []; spy.sitMinMax = []; spy.temps = []; });

describe('op-ed tuning params (t/203)', () => {
  it("absent params keep today's behaviour: 12 nodes, 1–3 situations, temperature 0.8, grounding on", async () => {
    const { set } = await run();
    expect(spy.nodeMaxTotal).toEqual([12]);
    expect(set.opeds[0].grounding.filter(g => g.category !== 'Situation')).toHaveLength(12);
    expect(spy.sitMinMax).toEqual([[1, 3]]);
    expect(set.opeds[0].grounding.filter(g => g.category === 'Situation')).toHaveLength(3);
    expect(spy.temps).toEqual([0.8]);
    expect(set.params).toMatchObject(OPED_TUNING_DEFAULTS);
  });

  it('maxGroundingNodes caps BDI grounding, including below the per-camp diversity floor', async () => {
    expect((await run({ maxGroundingNodes: 5 })).set.opeds[0].grounding.filter(g => g.category !== 'Situation')).toHaveLength(5);
    expect((await run({ maxGroundingNodes: 1 })).set.opeds[0].grounding.filter(g => g.category !== 'Situation')).toHaveLength(1);
    expect((await run({ maxGroundingNodes: 0 })).set.opeds[0].grounding.filter(g => g.category !== 'Situation')).toHaveLength(0);
  });

  it('maxSituations caps the shared situations (0 means none)', async () => {
    expect((await run({ maxSituations: 7 })).set.opeds[0].grounding.filter(g => g.category === 'Situation')).toHaveLength(7);
    const { set } = await run({ maxSituations: 0 });
    expect(spy.sitMinMax.at(-1)).toEqual([0, 0]);
    expect(set.opeds[0].grounding.filter(g => g.category === 'Situation')).toHaveLength(0);
  });

  it('temperature reaches the generation call and is recorded on its stage; other stages keep their own', async () => {
    const { set } = await run({ temperature: 1.3 });
    expect(spy.temps).toEqual([1.3]);
    const stages = set.opeds[0].stages!;
    expect(stages.find(s => s.stage === 'generation')!.temperature).toBe(1.3);
    expect(stages.find(s => s.stage === 'coherence-judge')!.temperature).toBe(0.1);
  });

  it('voiceOnly skips grounding entirely: no taxonomy load, no grounding event, no grounding refs', async () => {
    const { set, events } = await run({ voiceOnly: true });
    expect(spy.loadTaxonomy).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'grounding_done' || e.type === 'grounding_failed')).toBe(false);
    expect(set.opeds[0].grounding).toEqual([]);
    expect(set.opeds[0].status).toBe('complete');
  });

  it('out-of-range and non-numeric values are clamped or defaulted, each with a WARN, never thrown', () => {
    const warns: string[] = [];
    const deps = { recorder: { record: (e: { message?: string }) => warns.push(String(e.message)) } } as never;
    const t = resolveOpEdTuning({ model: 'm', wordCount: 0, maxGroundingNodes: 99, maxSituations: 2.6, temperature: -1, voiceOnly: 'yes' as never } as OpEdParams, deps);
    expect(t).toEqual({ maxGroundingNodes: 40, maxSituations: 3, temperature: 0, voiceOnly: false });
    expect(warns).toHaveLength(3);
    expect(warns[0]).toMatch(/maxGroundingNodes=99 is outside 0–40 \(integer\) — using 40/);
    const nan = resolveOpEdTuning({ model: 'm', wordCount: 0, temperature: Number.NaN } as OpEdParams, deps);
    expect(nan.temperature).toBe(0.8);
    expect(warns.at(-1)).toMatch(/is not a number — using the default 0.8/);
  });

  it('the values used survive the save-path parse', async () => {
    const { set } = await run({ maxGroundingNodes: 4, maxSituations: 2, temperature: 0.5, voiceOnly: false });
    const parsed = parseOpEdSet(JSON.parse(JSON.stringify(set)));
    expect(parsed.params).toMatchObject({ maxGroundingNodes: 4, maxSituations: 2, temperature: 0.5, voiceOnly: false });
    expect(parsed.opeds[0].stages!.find(s => s.stage === 'generation')!.temperature).toBe(0.5);
  });
});
