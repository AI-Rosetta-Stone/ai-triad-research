// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2719 — voices must generate SEQUENTIALLY (concurrency 1), not in a Promise.all
// fan-out. Parallel fan-out kept every voice's AI response + JSON.parse resident at once
// which, on top of the in-process ONNX model + embeddings + taxonomy, OOM-crashed the Node
// server mid-stream (a single create took the whole process down). This test locks the
// serialization: an instrumented adapter records the max number of concurrent generateText
// calls; sequential generation ⇒ 1, the old parallel fan-out ⇒ N (one per voice).

import { describe, it, expect, vi } from 'vitest';

vi.mock('../embeddings/onnxEmbedding.js', () => ({ computeEmbedding: async () => [1, 0, 0] }));
vi.mock('../debate/taxonomyLoader.js', () => ({
  loadTaxonomy: () => ({
    accelerationist: { nodes: [{ id: 'acc-bel-001', category: 'Belief', label: 'l', description: 'd', parent_id: null, children: [] }] },
    safetyist: { nodes: [{ id: 'saf-bel-001', category: 'Belief', label: 'l', description: 'd', parent_id: null, children: [] }] },
    skeptic: { nodes: [{ id: 'skp-bel-001', category: 'Belief', label: 'l', description: 'd', parent_id: null, children: [] }] },
    situations: { nodes: [{ id: 'sit-001', label: 'l', description: 'd', parent_id: null }] },
    embeddings: {},
  }),
}));
vi.mock('../debate/taxonomyRelevance.js', () => ({
  scoreNodeRelevance: () => new Map(),
  selectRelevantNodes: (nodes: { id: string }[]) => nodes.map(node => ({ node, score: 0.9 })),
  selectRelevantSituationNodes: (nodes: { id: string }[]) => nodes.map(node => ({ node, score: 0.8 })),
}));
vi.mock('./outletBands.js', () => ({ resolveOutletBand: () => ({ words: 800, guidance: 'g' }) }));
vi.mock('./promptLoader.js', () => ({
  loadAndAssemblePrompt: () => ({ system: 'sys', user: 'user' }),
  assembleReflectionPrompt: () => 'refl',
  assembleSourceBriefPrompt: () => 'source-brief-prompt',
}));

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateOpEdSet, type OpEdProgressEvent } from './generate.js';
import { parseOpEdSet } from './schemas.js';
import type { PovKey } from '../debate/types.js';
import type { OpEdSet } from './types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('generateOpEdSet — sequential voice generation (t/2719 OOM regression)', () => {
  it('never runs more than one voice generation concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter = {
      generateText: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so that, if voices were fanned out in parallel, their calls would overlap here.
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return JSON.stringify({ headline: 'H', subtitle: 'S', body_markdown: 'Body.', word_count: 1 });
      },
    };
    const req = {
      set_id: 's1', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist', 'safetyist', 'skeptic'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const completed: PovKey[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') completed.push(ev.pov);
    }

    // All three voices still produced (sequential doesn't drop any) …
    expect(completed.sort()).toEqual(['accelerationist', 'safetyist', 'skeptic']);
    // … but never more than one AI generation was in flight at once.
    expect(maxInFlight).toBe(1);
  });
});

describe('generateOpEdSet — document_claims propagation (t/2722)', () => {
  it('populates document_claims on grounding refs when reflection returns them', async () => {
    let call = 0;
    const adapter = {
      generateText: async () => {
        call++;
        if (call % 2 === 1) {
          // Essay generation call
          return JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body text here.', word_count: 3 });
        }
        // Reflection call — include document_claims for one node
        return JSON.stringify({
          grounding_usage: [
            { id: 'acc-bel-001', reflection: 'used in lede', document_claims: ['claim A', 'claim B'] },
            { id: 'sit-001', reflection: 'used as evidence', document_claims: [] },
          ],
        });
      },
    };
    const req = {
      set_id: 's2', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    let member: { grounding: { node_id: string; document_claims?: string[] }[] } | undefined;
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }

    expect(member).toBeDefined();
    const bdiRef = member!.grounding.find(r => r.node_id === 'acc-bel-001');
    expect(bdiRef?.document_claims).toEqual(['claim A', 'claim B']);
    // Empty document_claims array → field stays absent (only set when length > 0)
    const sitRef = member!.grounding.find(r => r.node_id === 'sit-001');
    expect(sitRef?.document_claims).toBeUndefined();
  });
});

describe('generateOpEdSet — document_claim_refs resolution (t/2938)', () => {
  it('resolves model-emitted claim NUMBERS to verbatim source claim text (dedup, drop out-of-range)', async () => {
    const KEY_CLAIMS = ['First claim', 'Second claim', 'Third claim'];
    let call = 0;
    const adapter = {
      generateText: async () => {
        call++;
        if (call === 1) {
          // Source-brief pass (triggered by request.sourceMaterial)
          return JSON.stringify({
            thesis: 't', author: 'a', actor_type: 'x', stance: 's',
            primary_recommendations: [], key_claims: KEY_CLAIMS, readable: true,
          });
        }
        if (call === 2) {
          // Essay generation
          return JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body text here.', word_count: 3 });
        }
        // Reflection — emit claim NUMBERS, not verbatim text. acc-bel-001 links
        // 1 & 3 (with a dup and an out-of-range 99 that must be dropped); sit-001 none.
        return JSON.stringify({
          grounding_usage: [
            { id: 'acc-bel-001', reflection: 'used in lede', document_claim_refs: [1, 3, 3, 99] },
            { id: 'sit-001', reflection: 'used as evidence', document_claim_refs: [] },
          ],
          claims: [{ text: 'First claim', paragraph: 1 }],
        });
      },
    };
    const req = {
      set_id: 's3', topic: 'AI policy',
      sourceMaterial: 'Some source article text.',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    let member: { grounding: { node_id: string; document_claims?: string[] }[] } | undefined;
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }

    expect(member).toBeDefined();
    const bdiRef = member!.grounding.find(r => r.node_id === 'acc-bel-001');
    // Numbers → verbatim text, deduped, out-of-range dropped.
    expect(bdiRef?.document_claims).toEqual(['First claim', 'Third claim']);
    const sitRef = member!.grounding.find(r => r.node_id === 'sit-001');
    expect(sitRef?.document_claims).toBeUndefined();
  });
});

describe('generateOpEdSet — FABRICATED_LEDE_GUARD integration (t/2730)', () => {
  const makeAdapter = (body: string) => ({
    generateText: async () => JSON.stringify({ headline: 'H', subtitle: '', body_markdown: body, word_count: body.split(/\s+/).length }),
  });
  const makeReq = (newsHook: string) => ({
    set_id: 'g1', topic: 'AI policy',
    params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook, thesis: '' } as never,
    povs: ['accelerationist'] as PovKey[],
  });
  const DEPS = { adapter: null as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

  it('fabricated_lede is absent when body is timeless and newsHook is empty', async () => {
    const deps = { ...DEPS, adapter: makeAdapter('The question of who controls AI has never been more consequential.') as never };
    let member: { fabricated_lede?: true } | undefined;
    for await (const ev of generateOpEdSet(makeReq(''), deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }
    expect(member?.fabricated_lede).toBeUndefined();
  });

  it('fabricated_lede is true when body contains a guard phrase and newsHook is empty', async () => {
    const deps = { ...DEPS, adapter: makeAdapter('This week regulators released a newly proposed pre-clearance rule for AI.') as never };
    let member: { fabricated_lede?: true } | undefined;
    for await (const ev of generateOpEdSet(makeReq(''), deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }
    expect(member?.fabricated_lede).toBe(true);
  });

  it('fabricated_lede is absent even when body has guard phrase if newsHook is non-empty', async () => {
    const deps = { ...DEPS, adapter: makeAdapter('This week regulators released a newly proposed pre-clearance rule for AI.') as never };
    let member: { fabricated_lede?: true } | undefined;
    for await (const ev of generateOpEdSet(makeReq('EU AI Act passed committee'), deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }
    expect(member?.fabricated_lede).toBeUndefined();
  });
});

describe('generateOpEdSet — Step 0 source-brief comprehension (t/2722)', () => {
  const ESSAY_JSON = JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body.', word_count: 1 });
  const REFL_JSON = JSON.stringify({ grounding_usage: [] });

  it('yields source_brief_done before grounding_done when comprehension succeeds', async () => {
    const BRIEF_JSON = JSON.stringify({
      thesis: 'AI labs must share safety research',
      author: 'Test Org', actor_type: 'think tank',
      stance: 'FOR mandatory sharing',
      primary_recommendations: ['Mandate sharing within 30 days'],
      key_claims: ['Safety incidents doubled last year', 'Only 3 labs share proactively'],
      readable: true,
    });
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'source-brief-prompt') return BRIEF_JSON;
        if (prompt === 'refl') return REFL_JSON;
        return ESSAY_JSON;
      },
    };
    const req = {
      set_id: 's3', topic: 'AI safety sharing',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
      sourceMaterial: 'Full document text...',
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const events: string[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      events.push(ev.type);
    }

    expect(events).toContain('source_brief_done');
    const briefIdx = events.indexOf('source_brief_done');
    const groundingIdx = events.indexOf('grounding_done');
    expect(briefIdx).toBeGreaterThanOrEqual(0);
    expect(groundingIdx).toBeGreaterThanOrEqual(0);
    expect(briefIdx).toBeLessThan(groundingIdx);
  });

  it('records a warning when the source brief comes back readable:false (t/2807)', async () => {
    const UNREADABLE_JSON = JSON.stringify({
      thesis: '', author: '', actor_type: '', stance: '',
      primary_recommendations: [], key_claims: [], readable: false,
    });
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'source-brief-prompt') return UNREADABLE_JSON;
        if (prompt === 'refl') return REFL_JSON;
        return ESSAY_JSON;
      },
    };
    const req = {
      set_id: 's-unreadable', topic: 'AI safety',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
      sourceMaterial: 'Unparseable gibberish',
    };
    const record = vi.fn();
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT, recorder: { record } };

    const events: string[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      events.push(ev.type);
    }

    // Non-fatal: Step 0 still completes and the set generates (from topic only)…
    expect(events).toContain('source_brief_done');
    expect(events).toContain('complete');
    // …but the supplied-but-unreadable source is recorded so it's diagnosable.
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'oped-generate' }));
  });

  it('yields source_brief_failed but still completes when comprehension throws', async () => {
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'source-brief-prompt') throw new Error('network error');
        if (prompt === 'refl') return REFL_JSON;
        return ESSAY_JSON;
      },
    };
    const req = {
      set_id: 's4', topic: 'AI safety',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
      sourceMaterial: 'Some text',
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const events: string[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      events.push(ev.type);
    }

    expect(events).toContain('source_brief_failed');
    expect(events).toContain('complete'); // non-fatal
    expect(events).not.toContain('source_brief_done');
  });

  it('skips Step 0 entirely when no sourceMaterial is provided', async () => {
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'source-brief-prompt') throw new Error('should not be called');
        if (prompt === 'refl') return REFL_JSON;
        return ESSAY_JSON;
      },
    };
    const req = {
      set_id: 's5', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const events: string[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      events.push(ev.type);
    }

    expect(events).not.toContain('source_brief_done');
    expect(events).not.toContain('source_brief_failed');
    expect(events).toContain('complete');
  });
});

describe('generateOpEdSet — source provenance + reflection observability (t/2898)', () => {
  const ESSAY_JSON = JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body.', word_count: 1 });
  const REFL_JSON = JSON.stringify({ grounding_usage: [] });
  const BRIEF_JSON = JSON.stringify({
    thesis: 'AI labs must share safety research', author: 'Test Org', actor_type: 'think tank',
    stance: 'FOR', primary_recommendations: ['Mandate sharing'],
    key_claims: ['Incidents doubled', 'Only 3 labs share'], readable: true,
  });
  const PROMPTS = join(REPO_ROOT, 'lib', 'oped', 'prompts');

  async function collect(req: Record<string, unknown>, deps: Record<string, unknown>): Promise<OpEdSet> {
    let set: OpEdSet | undefined;
    for await (const ev of generateOpEdSet(req as never, deps as never) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'complete') set = ev.set;
    }
    if (!set) throw new Error('no complete event');
    return set;
  }

  it('topic-mode set reads source_mode:"topic" with no url/count — distinguishable from the file alone', async () => {
    const adapter = { generateText: async (p: string) => (p === 'refl' ? REFL_JSON : ESSAY_JSON) };
    const set = await collect(
      { set_id: 't-topic', topic: 'AI policy', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'] },
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT },
    );
    expect(set.source_mode).toBe('topic');
    expect(set.source_url).toBeUndefined();
    expect(set.source_key_claims_count).toBeUndefined();
  });

  it('url-mode set reads source_mode:"url", source_url, and the key-claims count', async () => {
    const adapter = {
      generateText: async (p: string) => (p === 'source-brief-prompt' ? BRIEF_JSON : p === 'refl' ? REFL_JSON : ESSAY_JSON),
    };
    const set = await collect(
      { set_id: 't-url', topic: 'AI safety', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'], sourceMaterial: 'Doc text', sourceUrl: 'https://example.org/report' },
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT },
    );
    expect(set.source_mode).toBe('url');
    expect(set.source_url).toBe('https://example.org/report');
    expect(set.source_key_claims_count).toBe(2);
  });

  it('url-mode count is 0 when the source brief is unreadable (brief failed/empty)', async () => {
    const UNREADABLE = JSON.stringify({ thesis: '', author: '', actor_type: '', stance: '', primary_recommendations: [], key_claims: [], readable: false });
    const adapter = {
      generateText: async (p: string) => (p === 'source-brief-prompt' ? UNREADABLE : p === 'refl' ? REFL_JSON : ESSAY_JSON),
    };
    const set = await collect(
      { set_id: 't-url0', topic: 'AI safety', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'], sourceMaterial: 'gibberish', sourceUrl: 'https://example.org/x' },
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT },
    );
    expect(set.source_mode).toBe('url');
    expect(set.source_key_claims_count).toBe(0);
  });

  it('source_brief_done carries keyClaimsCount', async () => {
    const adapter = {
      generateText: async (p: string) => (p === 'source-brief-prompt' ? BRIEF_JSON : p === 'refl' ? REFL_JSON : ESSAY_JSON),
    };
    let count: number | undefined;
    for await (const ev of generateOpEdSet(
      { set_id: 't-evt', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'], sourceMaterial: 'Doc' } as never,
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'source_brief_done') count = ev.keyClaimsCount;
    }
    expect(count).toBe(2);
  });

  it('reflection-pass failure emits a recorder warning naming the pov — no longer silent', async () => {
    const adapter = {
      // 'refl' returns non-JSON → JSON.parse throws inside the reflection block.
      generateText: async (p: string) => (p === 'refl' ? 'not json at all' : ESSAY_JSON),
    };
    const record = vi.fn();
    let member: { pov: string } | undefined;
    for await (const ev of generateOpEdSet(
      { set_id: 't-refl', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: 'hook', thesis: '' }, povs: ['accelerationist'] } as never,
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT, recorder: { record } } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member;
    }
    // Non-fatal: the voice still completes …
    expect(member?.pov).toBe('accelerationist');
    // … but the reflection failure is now recorded (valid EventType, names the pov).
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.error', level: 'warn', component: 'opedGenerate',
      message: expect.stringContaining('reflection pass failed for pov=accelerationist'),
    }));
  });

  it('records a per-member claims_extracted count — including the zero case', async () => {
    const adapter = { generateText: async (p: string) => (p === 'refl' ? REFL_JSON : ESSAY_JSON) };
    const record = vi.fn();
    for await (const _ev of generateOpEdSet(
      { set_id: 't-count', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: 'hook', thesis: '' }, povs: ['accelerationist'] } as never,
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT, recorder: { record } } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) { /* drain */ }
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.info', component: 'opedGenerate',
      data: expect.objectContaining({ claims_extracted: 0, pov: 'accelerationist' }),
    }));
  });

  it('schema round-trip retains the three new provenance fields (no strip)', () => {
    const raw: OpEdSet = {
      schema_version: 1, set_id: 's', topic: 't',
      params: { model: 'm', wordCount: 800 }, created_at: '2026-08-21T00:00:00Z',
      opeds: [],
      source_mode: 'url', source_url: 'https://example.org/a', source_key_claims_count: 4,
    };
    const round = parseOpEdSet(JSON.parse(JSON.stringify(raw)));
    expect(round.source_mode).toBe('url');
    expect(round.source_url).toBe('https://example.org/a');
    expect(round.source_key_claims_count).toBe(4);
  });

  it('legacy set without provenance fields still parses (no migration)', () => {
    const legacy = {
      schema_version: 1, set_id: 's', topic: 't',
      params: { model: 'm', wordCount: 800 }, created_at: '2026-08-21T00:00:00Z', opeds: [],
    };
    const round = parseOpEdSet(legacy);
    expect(round.source_mode).toBeUndefined();
  });
});

// ── Reflection retry-on-empty insurance (t/2919) ──────────────────────────────
// The ~50% systematic emission defect was FALSIFIED by measurement (22/22, t/2919#1);
// this single fail-safe retry guards only a rare transient LLM empty when a source brief
// with key_claims existed but the reflection came back with no claims. Mirrors the narrate
// empty-entries presence gate (t/2872). Fires ONLY on "should-have-but-didn't" (url mode);
// never on a legitimate topic-mode empty.
describe('generateOpEdSet — reflection retry-on-empty (t/2919)', () => {
  const ESSAY = JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body text here.', word_count: 3 });
  const BRIEF = JSON.stringify({ thesis: 't', author: 'a', actor_type: 'x', stance: 's', primary_recommendations: ['r'], key_claims: ['claim one', 'claim two'], readable: true });
  const REFL_EMPTY = JSON.stringify({ grounding_usage: [{ id: 'acc-bel-001', reflection: 'used' }] }); // no top-level claims
  const REFL_FULL = JSON.stringify({ grounding_usage: [{ id: 'acc-bel-001', reflection: 'used', document_claims: ['claim one'] }], claims: [{ text: 'claim one', paragraph: 1 }] });
  const PROMPTS = join(REPO_ROOT, 'lib', 'oped', 'prompts');

  it('retries once and recovers claims when a source brief has key_claims but the first reflection returned none', async () => {
    let reflCall = 0;
    const adapter = { generateText: async (p: string) => {
      if (p === 'source-brief-prompt') return BRIEF;
      if (p === 'refl') { reflCall++; return reflCall === 1 ? REFL_EMPTY : REFL_FULL; }
      return ESSAY;
    } };
    const record = vi.fn();
    let member: { claims?: { text: string; paragraph: number }[] } | undefined;
    for await (const ev of generateOpEdSet(
      { set_id: 's-retry', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'], sourceMaterial: 'Doc', sourceUrl: 'https://example.org/x' } as never,
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT, recorder: { record } } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }
    expect(reflCall).toBe(2);                    // retry fired
    expect(member?.claims?.length).toBe(1);      // retry recovered the claims
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'reflection-retry' }) }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'reflection-retry-outcome', succeeded: true }) }));
  });

  it('does NOT retry in topic mode (no source brief) even when the reflection has no claims', async () => {
    let reflCall = 0;
    const adapter = { generateText: async (p: string) => {
      if (p === 'refl') { reflCall++; return REFL_EMPTY; }
      return ESSAY;
    } };
    const record = vi.fn();
    for await (const _ev of generateOpEdSet(
      { set_id: 's-topic', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'] } as never, // no sourceMaterial
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT, recorder: { record } } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) { /* drain */ }
    expect(reflCall).toBe(1);                     // no retry — legitimately-empty topic-mode reflection
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'reflection-retry' }) }));
  });

  it('does NOT retry when the first reflection already produced claims', async () => {
    let reflCall = 0;
    const adapter = { generateText: async (p: string) => {
      if (p === 'source-brief-prompt') return BRIEF;
      if (p === 'refl') { reflCall++; return REFL_FULL; }
      return ESSAY;
    } };
    let member: { claims?: unknown[] } | undefined;
    for await (const ev of generateOpEdSet(
      { set_id: 's-ok', topic: 'AI', params: { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' }, povs: ['accelerationist'], sourceMaterial: 'Doc', sourceUrl: 'https://example.org/x' } as never,
      { adapter, promptsDir: PROMPTS, repoRoot: REPO_ROOT } as never,
    ) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_complete') member = ev.member as typeof member;
    }
    expect(reflCall).toBe(1);                     // no retry needed
    expect(member?.claims?.length).toBe(1);
  });
});

// ── Empty voice response → failed, not blank-complete (t/3013) ────────────────
// An empty AI response ('' — Gemini can return a candidate with empty/absent text parts on a
// safety block or certain truncations, which generateViaGemini joins to '') previously fell
// through JSON.parse('') into the raw-text fallback, so the voice finalized status:'complete'
// with an empty body — a blank op-ed tab with no error state. runVoiceGeneration's empty-text
// guard now throws, so runVoice marks the voice failed and emits voice_failed.
describe('generateOpEdSet — empty voice response finalizes as failed, not blank-complete (t/3013)', () => {
  it('a voice whose essay comes back empty yields voice_failed + status:failed; other voices unaffected', async () => {
    let essayCall = 0;
    const adapter = {
      // Reflection calls use the 'refl' prompt (mocked) and don't increment the essay counter,
      // so essayCall maps 1:1 to voices in request.povs order → the 2nd voice (safetyist) gets ''.
      generateText: async (prompt: string) => {
        if (prompt === 'refl') return JSON.stringify({ grounding_usage: [] });
        essayCall++;
        if (essayCall === 2) return ''; // safetyist essay comes back empty (empty Gemini candidate)
        return JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body.', word_count: 1 });
      },
    };
    const req = {
      set_id: 's-empty', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist', 'safetyist', 'skeptic'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const failed: PovKey[] = [];
    const completed: PovKey[] = [];
    let set: OpEdSet | undefined;
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_failed') failed.push(ev.pov);
      if (ev.type === 'voice_complete') completed.push(ev.pov);
      if (ev.type === 'complete') set = ev.set;
    }

    // The empty voice now surfaces as a failure (previously a silent empty-complete → blank tab).
    expect(failed).toEqual(['safetyist']);
    expect(completed.sort()).toEqual(['accelerationist', 'skeptic']);

    // …and it finalizes in the set as status:'failed' with an empty body — the render layer's
    // OpEdArticle failed-state notice keys on status !== 'complete', so the tab is no longer blank.
    const members = set!.opeds as unknown as { pov: string; status: string; body: string }[];
    expect(members.find(m => m.pov === 'safetyist')?.status).toBe('failed');
    expect(members.find(m => m.pov === 'safetyist')?.body).toBe('');
    // Unaffected voices still complete normally.
    expect(members.find(m => m.pov === 'accelerationist')?.status).toBe('complete');
    expect(members.find(m => m.pov === 'skeptic')?.status).toBe('complete');
  });
});

// ── Non-JSON / truncated voice response → failed, not garbage-complete (t/3013 sibling) ───────
// A NON-empty but non-JSON essay response (a truncated response leaving unterminated JSON, or
// prose / ```json fences surviving stripCodeFences) previously fell into the JSON.parse raw-text
// fallback, which stored the raw text as body_markdown → rendered as a monospace code block with
// an always-empty headline. runVoiceGeneration now throws on a JSON.parse failure, so runVoice
// marks the voice failed + emits voice_failed → the existing OpEdArticle notice renders cleanly.
describe('generateOpEdSet — non-JSON voice response finalizes as failed, not garbage-complete (t/3013 sibling)', () => {
  it('a voice whose essay is non-empty but invalid JSON yields voice_failed + status:failed; others unaffected', async () => {
    let essayCall = 0;
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'refl') return JSON.stringify({ grounding_usage: [] });
        essayCall++;
        // Truncated JSON (token-budget exhaustion): non-empty, no code fences, JSON.parse throws on the unterminated string.
        if (essayCall === 2) return '{"headline":"H","body_markdown":"Lorem ipsum dolor sit';
        return JSON.stringify({ headline: 'H', subtitle: '', body_markdown: 'Body.', word_count: 1 });
      },
    };
    const req = {
      set_id: 's-badjson', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist', 'safetyist', 'skeptic'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };

    const failed: PovKey[] = [];
    const completed: PovKey[] = [];
    let set: OpEdSet | undefined;
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_failed') failed.push(ev.pov);
      if (ev.type === 'voice_complete') completed.push(ev.pov);
      if (ev.type === 'complete') set = ev.set;
    }

    // The invalid-JSON voice fails (previously a silent garbage-complete → code-block tab with empty headline).
    expect(failed).toEqual(['safetyist']);
    expect(completed.sort()).toEqual(['accelerationist', 'skeptic']);

    const members = set!.opeds as unknown as { pov: string; status: string; body: string }[];
    expect(members.find(m => m.pov === 'safetyist')?.status).toBe('failed');
    expect(members.find(m => m.pov === 'safetyist')?.body).toBe(''); // the raw garbage is NOT stored as the body
    expect(members.find(m => m.pov === 'accelerationist')?.status).toBe('complete');
    expect(members.find(m => m.pov === 'skeptic')?.status).toBe('complete');
  });
});

// ── voice_failed carries the thrown error's stable code (t/668) ──────────────
// The client maps refusals (e.g. FREE_POOL_EXHAUSTED) on this code, not on message text.
describe('generateOpEdSet — voice_failed carries the error code (t/668)', () => {
  it('a voice whose adapter throws an error with a code emits voice_failed with that code', async () => {
    const adapter = {
      generateText: async (prompt: string) => {
        if (prompt === 'refl') return JSON.stringify({ grounding_usage: [] });
        throw Object.assign(new Error('pool exhausted'), { code: 'FREE_POOL_EXHAUSTED' });
      },
    };
    const req = {
      set_id: 's-code', topic: 'AI policy',
      params: { model: 'gemini-flash', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '' } as never,
      povs: ['accelerationist'] as PovKey[],
    };
    const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT };
    const failed: { pov: PovKey; code?: string }[] = [];
    for await (const ev of generateOpEdSet(req, deps) as AsyncGenerator<OpEdProgressEvent>) {
      if (ev.type === 'voice_failed') failed.push({ pov: ev.pov, code: ev.code });
    }
    expect(failed).toEqual([{ pov: 'accelerationist', code: 'FREE_POOL_EXHAUSTED' }]);
  });
});
