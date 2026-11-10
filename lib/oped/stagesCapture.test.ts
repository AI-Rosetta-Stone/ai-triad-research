// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/171: every model call the op-ed pipeline makes is captured on the member as `stages[]`, in the order it
// ran, with the exact prompt sent and the raw output (or the error), for the How panel (t/170). Every prompt
// builder is mocked to a labelled string so the fake model can answer by stage and the test controls which
// optional stages run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ctl = vi.hoisted(() => ({
  flagged: false,          // coherence judge flags something -> rewrite + rejudge run
  needsEdit: false,        // body misses readability targets -> readability-edit runs
  reflectionClaims: true,  // reflection returns claims (false + key_claims -> reflection retries once)
  failGeneration: false,
  hugeOutput: false,
}));

vi.mock('../embeddings/onnxEmbedding.js', () => ({ computeEmbedding: async () => [1, 0, 0] }));
vi.mock('../debate/taxonomyLoader.js', () => ({
  loadTaxonomy: () => ({
    accelerationist: { nodes: [{ id: 'acc-bel-001', category: 'Belief', label: 'l', description: 'd', parent_id: null, children: [] }] },
    safetyist: { nodes: [{ id: 'saf-bel-001', category: 'Belief', label: 'l', description: 'd', parent_id: null, children: [] }] },
    skeptic: { nodes: [] },
    situations: { nodes: [] },
    embeddings: {},
  }),
}));
vi.mock('../debate/taxonomyRelevance.js', () => ({
  scoreNodeRelevance: () => new Map(),
  selectRelevantNodes: (nodes: { id: string }[]) => nodes.map(node => ({ node, score: 0.9 })),
  selectRelevantSituationNodes: () => [],
}));
vi.mock('./outletBands.js', () => ({ resolveOutletBand: () => ({ words: 800, guidance: 'g' }) }));
vi.mock('./promptLoader.js', () => ({
  loadAndAssemblePrompt: () => ({ system: 'SYS', user: 'USER' }),
  assembleSourceBriefPrompt: () => 'P:source-brief',
  assembleCoherenceJudgePrompt: (_d: string, body: string) => `P:judge:${body}`,
  assembleCoherenceRewritePrompt: () => 'P:rewrite',
  assembleReadabilityEditPrompt: () => 'P:edit',
  assembleReflectionPrompt: () => 'P:reflection',
}));
vi.mock('./coherenceCheck.js', () => ({
  COHERENCE_JUDGE_SCHEMA: {},
  normalizeJudgeResult: (r: { checks?: unknown[] }) => r.checks ?? [],
  validFlags: (checks: unknown[]) => checks,
  buildCoherenceViolationsText: () => 'violations',
}));
vi.mock('./readabilityMeasure.js', async (orig) => ({
  ...(await orig<typeof import('./readabilityMeasure.js')>()),
  needsEdit: () => ctl.needsEdit,
}));

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateOpEdSet, OPED_STAGE_TEXT_CAP } from './generate.js';
import { parseOpEdSet } from './schemas.js';
import type { PovKey } from '../debate/types.js';
import type { OpEdSet } from './types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BODY = 'The original body has enough words to survive the collapse guard in the edit pass.';
const ESSAY = JSON.stringify({ headline: 'H', subtitle: 'S', body_markdown: BODY, word_count: 15 });

function answer(prompt: string): string {
  if (prompt === 'P:source-brief') return JSON.stringify({ readable: true, thesis: 't', key_claims: ['claim one'] });
  if (prompt === 'SYS\n\n---\n\nUSER') {
    if (ctl.failGeneration) throw new Error('model unavailable');
    return ctl.hugeOutput ? ESSAY + ' '.repeat(OPED_STAGE_TEXT_CAP) : ESSAY;
  }
  if (prompt === `P:judge:${BODY}`) {
    return JSON.stringify({ checks: ctl.flagged ? [{ check_id: 'thesis_solution', span_a: 'a', span_b: 'b', why: 'w' }] : [] });
  }
  if (prompt.startsWith('P:judge:')) return JSON.stringify({ checks: [] }); // the rejudge of the rewrite
  if (prompt === 'P:rewrite') return 'The rewritten body has enough words to survive the collapse guard in the edit pass.';
  if (prompt === 'P:edit') return JSON.stringify({ body_markdown: 'The edited body has enough words to survive the collapse guard in the edit pass.' });
  if (prompt === 'P:reflection') {
    return JSON.stringify({ grounding_usage: [], claims: ctl.reflectionClaims ? [{ text: 'c', paragraph: 1 }] : [] });
  }
  throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
}

async function run(opts: { url?: boolean; povs?: PovKey[] } = {}): Promise<{ set: OpEdSet; warns: string[] }> {
  const warns: string[] = [];
  const req = {
    set_id: 's1', topic: 'AI policy',
    params: { model: 'test-model', wordCount: 800, outlet: 'nyt', newsHook: 'hook', thesis: '' } as never,
    povs: opts.povs ?? (['accelerationist'] as PovKey[]),
    ...(opts.url && { sourceMaterial: 'article text', sourceUrl: 'https://example.com/a' }),
  };
  const deps = {
    adapter: { generateText: async (p: string) => answer(p) } as never,
    promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'),
    repoRoot: REPO_ROOT,
    recorder: { record: (e: { level?: string; message?: string }) => { if (e.level === 'warn') warns.push(String(e.message)); } } as never,
  };
  let set: OpEdSet | undefined;
  for await (const ev of generateOpEdSet(req, deps)) if (ev.type === 'complete') set = ev.set;
  return { set: set!, warns };
}

const names = (set: OpEdSet, i = 0) => (set.opeds[i].stages ?? []).map(s => `${s.stage}#${s.attempt}`);

beforeEach(() => Object.assign(ctl, { flagged: false, needsEdit: false, reflectionClaims: true, failGeneration: false, hugeOutput: false }));

describe('op-ed stage capture (t/171)', () => {
  it('captures every stage that ran, once, in pipeline order, with the exact prompt and the raw output', async () => {
    Object.assign(ctl, { flagged: true, needsEdit: true });
    const { set } = await run({ url: true });
    expect(names(set)).toEqual([
      'source-brief#1', 'generation#1', 'coherence-judge#1', 'coherence-rewrite#1',
      'coherence-rejudge#1', 'readability-edit#1', 'grounding-reflection#1',
    ]);
    const gen = set.opeds[0].stages!.find(s => s.stage === 'generation')!;
    expect(gen).toEqual({ stage: 'generation', attempt: 1, model: 'test-model', prompt: 'SYS\n\n---\n\nUSER', output: ESSAY });
    expect(set.opeds[0].stages!.every(s => s.error === undefined)).toBe(true);
  });

  it('skipped stages are absent: topic mode, nothing flagged, already readable', async () => {
    const { set } = await run();
    expect(names(set)).toEqual(['generation#1', 'coherence-judge#1', 'grounding-reflection#1']);
  });

  it('a retried call is a second entry with attempt 2 (reflection retry on empty claims, t/2919)', async () => {
    ctl.reflectionClaims = false;
    const { set } = await run({ url: true });
    expect(names(set).slice(-2)).toEqual(['grounding-reflection#1', 'grounding-reflection#2']);
  });

  it('the set-level source brief is copied into every member as entry 0 (members are self-contained)', async () => {
    const { set } = await run({ url: true, povs: ['accelerationist', 'safetyist'] });
    expect(set.opeds.map(m => m.stages![0].stage)).toEqual(['source-brief', 'source-brief']);
    expect(set.opeds[0].stages![0]).not.toBe(set.opeds[1].stages![0]);
  });

  it('a failed member keeps the stages that ran, and the failing call carries the error with empty output', async () => {
    ctl.failGeneration = true;
    const { set } = await run({ url: true });
    expect(set.opeds[0].status).toBe('failed');
    expect(names(set)).toEqual(['source-brief#1', 'generation#1']);
    expect(set.opeds[0].stages![1]).toMatchObject({ output: '', error: 'Error: model unavailable' });
  });

  it('text over the cap is truncated with an explicit marker and a WARN', async () => {
    ctl.hugeOutput = true;
    const { set, warns } = await run();
    const out = set.opeds[0].stages!.find(s => s.stage === 'generation')!.output;
    expect(out.length).toBeLessThan(OPED_STAGE_TEXT_CAP + 40);
    expect(out).toMatch(new RegExp(`…\\[truncated ${ESSAY.length} chars\\]$`));
    expect(warns.some(w => w.includes('generation output') && w.includes('capture cap'))).toBe(true);
  });

  it('stages survive the save-path parse unchanged, and an unknown stage name is kept, not rejected', async () => {
    Object.assign(ctl, { flagged: true, needsEdit: true });
    const { set } = await run({ url: true });
    expect(parseOpEdSet(JSON.parse(JSON.stringify(set))).opeds[0].stages).toEqual(set.opeds[0].stages);
    const future = JSON.parse(JSON.stringify(set));
    future.opeds[0].stages.push({ stage: 'future-stage', attempt: 1, model: 'm', prompt: 'p', output: 'o' });
    expect(parseOpEdSet(future).opeds[0].stages!.at(-1)!.stage).toBe('future-stage');
    const legacy = JSON.parse(JSON.stringify(set));
    delete legacy.opeds[0].stages;
    expect(parseOpEdSet(legacy).opeds[0].stages).toBeUndefined();
  });
});
