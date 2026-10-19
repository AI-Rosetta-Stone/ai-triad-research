// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// POV tags 6/8: op-ed (t/3960; TL t/3960#3/#8, SO e/254#6, CL t/3960#5). The tag applies to ONE member;
// every other member is identical to an untagged run. Bad, missing-soul and thin-Scope tags refuse before
// any generation. The byline keeps the POV label. Every member records which soul file voiced it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolvePoverInfo: vi.fn(),
  getSoulDocument: vi.fn(),
  promptArgs: [] as { pov: string; povLabel: string; voiceBlock: string }[],
  selectCalls: [] as { ids: string[]; scores: Map<string, number> }[],
}));

// A registry with two Skeptic wings: "critical" has enough tagged nodes, "institutional" too few.
vi.mock('../../debate/soul-docs/pov-tags.json', () => ({
  default: {
    version: 1,
    povs: {
      skeptic: [
        { id: 'critical', label: 'Critical', soul_doc: 'skeptic.critical', description: 'Critical wing' },
        { id: 'institutional', label: 'Institutional', soul_doc: 'skeptic.institutional', description: 'Institutional wing' },
        // Registered, but no node carries it: the state of the real corpus today (CL p/736#27).
        { id: 'untagged-wing', label: 'Untagged', soul_doc: 'skeptic.untagged-wing', description: 'No node carries this' },
        // Carried only by skp-beliefs-006, which has no embedding: tagged but not groundable (CL p/736#44).
        { id: 'ghost', label: 'Ghost', soul_doc: 'skeptic.ghost', description: 'Only an unembedded node carries this' },
      ],
    },
  },
}));

vi.mock('../../debate/soulDocLoader.js', () => ({ resolvePoverInfo: h.resolvePoverInfo, getSoulDocument: h.getSoulDocument }));

const skp = (n: number, tags?: string[]) => ({
  id: `skp-beliefs-${String(n).padStart(3, '0')}`, category: 'Beliefs', label: `Skeptic ${n}`, description: 'd',
  parent_id: null, children: [], ...(tags ? { pov_tags: tags } : {}),
});
vi.mock('../../debate/taxonomyLoader.js', () => ({
  loadTaxonomy: () => ({
    accelerationist: { nodes: [
      { id: 'acc-beliefs-001', category: 'Beliefs', label: 'Acc 1', description: 'd', parent_id: null, children: [] },
      { id: 'acc-desires-001', category: 'Desires', label: 'Acc 2', description: 'd', parent_id: null, children: [] },
    ] },
    safetyist: { nodes: [
      { id: 'saf-beliefs-001', category: 'Beliefs', label: 'Saf 1', description: 'd', parent_id: null, children: [] },
    ] },
    // 6 nodes tagged "critical", 3 tagged "institutional", 2 untagged. skp-beliefs-006 and skp-beliefs-009 have
    // NO embedding, so "critical" has 5 groundable (sufficient), "institutional" 1 (thin), "ghost" 0 (tagged,
    // not groundable). skp-beliefs-009 is institutional-ONLY: a Scope on "critical" excludes it although it is
    // tagged, the real prod shape behind t/4275.
    skeptic: { nodes: [
      skp(1, ['critical']), skp(2, ['critical']), skp(3, ['critical']), skp(4, ['critical']),
      skp(5, ['critical', 'institutional']), skp(6, ['critical', 'institutional', 'ghost']), skp(7), skp(8),
      skp(9, ['institutional']),
    ] },
    situations: { nodes: [{ id: 'sit-001', label: 'Sit', description: 'd', parent_id: null }] },
    embeddings: Object.fromEntries(
      ['acc-beliefs-001', 'acc-desires-001', 'saf-beliefs-001', 'skp-beliefs-001', 'skp-beliefs-002', 'skp-beliefs-003',
        'skp-beliefs-004', 'skp-beliefs-005', 'skp-beliefs-007', 'skp-beliefs-008']
        .map((id) => [id, { pov: id.slice(0, 3), vector: [1, 0, 0] }]),
    ),
  }),
}));

vi.mock('../../embeddings/onnxEmbedding.js', () => ({ computeEmbedding: async () => [1, 0, 0] }));

// Echo the candidate nodes back, scored from the map the generator passed, so the test sees exactly which
// nodes and scores each camp was selected from.
// Every node has an embedding (a score) EXCEPT skp-beliefs-006, which is tagged critical + institutional,
// and skp-beliefs-009 (institutional only): tagged nodes that cannot ground (TL p/736#43).
vi.mock('../../debate/taxonomyRelevance.js', () => ({
  scoreNodeRelevance: () => new Map<string, number>([
    ['acc-beliefs-001', 0.3], ['acc-desires-001', 0.3], ['saf-beliefs-001', 0.3],
    ['skp-beliefs-001', 0.4], ['skp-beliefs-002', 0.3], ['skp-beliefs-003', 0.3], ['skp-beliefs-004', 0.3],
    ['skp-beliefs-005', 0.3], ['skp-beliefs-007', 0.5], ['skp-beliefs-008', 0.3],
  ]),
  selectRelevantNodes: (nodes: { id: string }[], scores: Map<string, number>) => {
    h.selectCalls.push({ ids: nodes.map((n) => n.id), scores });
    return nodes.map((node) => ({ node, score: scores.get(node.id) ?? 0 }));
  },
  selectRelevantSituationNodes: (nodes: { id: string }[]) => nodes.map((node) => ({ node, score: 0.8 })),
}));

vi.mock('../outletBands.js', () => ({ resolveOutletBand: () => ({ words: 800, guidance: 'guidance' }) }));
vi.mock('../promptLoader.js', () => ({
  loadAndAssemblePrompt: (_dir: string, args: { pov: string; povLabel: string; voiceBlock: string }) => {
    h.promptArgs.push({ pov: args.pov, povLabel: args.povLabel, voiceBlock: args.voiceBlock });
    return { system: 'sys', user: 'user' };
  },
  assembleReflectionPrompt: () => 'refl',
}));

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateOpEdSet, type OpEdProgressEvent } from '../generate.js';
import { ActionableError } from '../../debate/errors.js';
import { TAG_BOOST_INCREMENT } from '../../debate/debateConfig.js';
import { parseOpEdRequest, parseOpEdSet } from '../schemas.js';
import { AppliedTagSchema, APPLIED_TAG_COUNT_MEANING } from '../../schema/povTags.js';
import type { OpEdMember, OpEdParams } from '../types.js';
import type { PovKey } from '../../debate/types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const POVS: PovKey[] = ['accelerationist', 'safetyist', 'skeptic'];

// The tag soul: the real Skeptic soul with a recognisable personality and its own label, which must NOT
// become the byline identity.
const TAG_SOUL = {
  ...JSON.parse(readFileSync(join(REPO_ROOT, 'lib', 'debate', 'soul-docs', 'skeptic.soul.json'), 'utf-8')),
  tag: 'critical', label: 'Critical', personality: 'CRITICAL-WING PERSONALITY',
};

const adapter = { generateText: vi.fn(async () => JSON.stringify({ headline: 'H', subtitle: 'S', body_markdown: 'Body words here.', word_count: 3 })) };

async function run(tagSelection?: OpEdParams['tagSelection'], recorder = { record: vi.fn() }): Promise<Map<PovKey, OpEdMember>> {
  const params = { model: 'm', wordCount: 800, outlet: 'nyt', newsHook: '', thesis: '', ...(tagSelection ? { tagSelection } : {}) } as OpEdParams;
  const deps = { adapter: adapter as never, promptsDir: join(REPO_ROOT, 'lib', 'oped', 'prompts'), repoRoot: REPO_ROOT, recorder };
  const out = new Map<PovKey, OpEdMember>();
  for await (const ev of generateOpEdSet({ set_id: 's', topic: 'AI policy', params, povs: POVS }, deps) as AsyncGenerator<OpEdProgressEvent>) {
    if (ev.type === 'voice_complete') out.set(ev.pov, ev.member);
  }
  return out;
}

beforeEach(() => {
  h.promptArgs.length = 0;
  h.selectCalls.length = 0;
  adapter.generateText.mockClear();
  const POV_LABELS: Record<string, string> = { accelerationist: 'Accelerationist', safetyist: 'Safetyist', skeptic: 'Skeptic' };
  h.resolvePoverInfo.mockReset();
  // Tag-aware (t/4007): loadSoulDoc calls resolvePoverInfo(pov) for base-soul provenance; tagged path passes tagSelection.
  h.resolvePoverInfo.mockImplementation((pov: string, tagSel?: object) => tagSel
    ? { soul: { label: 'Skeptic', pov: 'skeptic' }, soulProvenance: { file: 'C:\\checkout\\lib\\debate\\soul-docs\\skeptic.critical.soul.json', hash: 'abcdef0123456789' } }
    : { soul: { label: POV_LABELS[pov] ?? pov, pov }, soulProvenance: { file: `${pov}.soul.json`, hash: 'fnv1a64:1234567890abcdef' } },
  );
  h.getSoulDocument.mockReset();
  // Tag-aware: base calls (loadSoulDoc — t/4007) get the correct POV label; tagged calls get TAG_SOUL.
  h.getSoulDocument.mockImplementation((pov: string, tag?: string) =>
    tag ? TAG_SOUL : { ...TAG_SOUL, pov, label: POV_LABELS[pov] ?? pov, tag: undefined },
  );
});

describe('op-ed tag selection: Scope', () => {
  it('grounds the tagged member only on tagged nodes and records what the tag did', async () => {
    const recorder = { record: vi.fn() };
    const members = await run({ pov: 'skeptic', tag: 'critical', mode: 'scope' }, recorder);
    const skeptic = members.get('skeptic')!;
    expect(skeptic.grounding.filter((g) => g.node_id.startsWith('skp-')).map((g) => g.node_id).sort())
      .toEqual(['skp-beliefs-001', 'skp-beliefs-002', 'skp-beliefs-003', 'skp-beliefs-004', 'skp-beliefs-005', 'skp-beliefs-006']);
    // `included` counts only GROUNDABLE tagged nodes: skp-beliefs-006 is tagged but has no embedding.
    expect(skeptic.tag).toEqual({ pov: 'skeptic', tag: 'critical', mode: 'scope', included: 5, excludedUntagged: 3 });
    // Fallback-path logging: the narrowing is visible, and so is the tagged node that cannot ground (TL p/736#43).
    // 3 = 2 untagged + skp-beliefs-009 tagged institutional; the WARN must not call them all untagged (t/4275).
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('excluded 3 skeptic nodes not tagged critical') }));
    expect(recorder.record).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('untagged') }));
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('1 tagged skeptic node(s) have no embedding and cannot ground (5 can)') }));
  });

  it('voices the tagged member with the tag soul, but keeps the POV label in the byline and prompt', async () => {
    const members = await run({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    const skeptic = members.get('skeptic')!;
    expect(skeptic.byline).toBe('By the Skeptic Camp (Critical wing), as modeled in AI Rosetta Stone');
    expect(skeptic.byline).not.toMatch(/By the Critical Camp/);
    expect(skeptic.disclosure).toContain('illustrate the Critical wing of the Skeptic perspective');
    const skepticPrompt = h.promptArgs.find((a) => a.pov === 'skeptic')!;
    expect(skepticPrompt.povLabel).toBe('Skeptic (Critical wing)');
    expect(skepticPrompt.voiceBlock).toContain('CRITICAL-WING PERSONALITY');
    expect(h.resolvePoverInfo).toHaveBeenCalledWith('skeptic', { tag: 'critical', mode: 'scope' });
  });

  it('records a repo-relative soul file for the tagged member, never the absolute path', async () => {
    const members = await run({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    expect(members.get('skeptic')!.soul).toEqual({ file: 'skeptic.critical.soul.json', hash: 'abcdef0123456789' });
  });

  it('leaves every OTHER member identical to an untagged run (SO e/252 cond 5 form)', async () => {
    const untagged = await run();
    const untaggedPrompts = [...h.promptArgs];
    const tagged = await run({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    for (const pov of ['accelerationist', 'safetyist'] as PovKey[]) {
      expect(tagged.get(pov), pov).toEqual(untagged.get(pov));
      expect(h.promptArgs.find((a) => a.pov === pov), pov).toEqual(untaggedPrompts.find((a) => a.pov === pov));
      expect(tagged.get(pov)!.tag).toBeUndefined();
    }
  });
});

describe('op-ed tag selection: Prioritize', () => {
  it('keeps every node, boosts the tagged ones, and records excludedUntagged as 0', async () => {
    const members = await run({ pov: 'skeptic', tag: 'critical', mode: 'prioritize' });
    const call = h.selectCalls.find((c) => c.ids.some((id) => id.startsWith('skp-')))!;
    expect(call.ids).toHaveLength(9);
    expect(call.scores.get('skp-beliefs-001')).toBeCloseTo(0.4 + TAG_BOOST_INCREMENT);
    expect(call.scores.get('skp-beliefs-007')).toBe(0.5); // untagged: not boosted
    expect(call.scores.has('skp-beliefs-006')).toBe(false); // tagged but unembedded: never gets a score from the boost
    expect(members.get('skeptic')!.tag).toEqual({ pov: 'skeptic', tag: 'critical', mode: 'prioritize', included: 5, excludedUntagged: 0 });
  });
});

describe('op-ed tag selection: pre-flight refusals (no generation, no partial set)', () => {
  async function refusal(tagSelection: OpEdParams['tagSelection']): Promise<unknown> {
    try {
      await run(tagSelection);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it('REFUSES a thin Scope, with the counts, instead of warning (TL t/3960#3 cond 1)', async () => {
    const err = await refusal({ pov: 'skeptic', tag: 'institutional', mode: 'scope' });
    expect(err).toBeInstanceOf(ActionableError);
    // Both numbers: 3 tagged, only 1 groundable (skp-beliefs-006 and -009 have no embedding).
    expect(String((err as Error).message)).toMatch(/3 skeptic node\(s\) tagged, 1 of them with an embedding/);
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('REFUSES a tag no node carries, in BOTH modes (CL p/736#27: the corpus is untagged today)', async () => {
    for (const mode of ['scope', 'prioritize'] as const) {
      const err = await refusal({ pov: 'skeptic', tag: 'untagged-wing', mode });
      expect(err, mode).toBeInstanceOf(ActionableError);
      expect(String((err as Error).message), mode).toMatch(/No groundable skeptic node carries the tag "untagged-wing".*0 skeptic node\(s\) tagged/);
    }
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('REFUSES a tag carried only by unembedded nodes, in BOTH modes: the floor counts groundable nodes (CL p/736#44)', async () => {
    for (const mode of ['scope', 'prioritize'] as const) {
      const err = await refusal({ pov: 'skeptic', tag: 'ghost', mode });
      expect(err, mode).toBeInstanceOf(ActionableError);
      expect(String((err as Error).message), mode).toMatch(/1 skeptic node\(s\) tagged, 0 of them with an embedding/);
    }
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('allows the same thin tag in Prioritize, which excludes nothing (counting only the groundable node)', async () => {
    const members = await run({ pov: 'skeptic', tag: 'institutional', mode: 'prioritize' });
    expect(members.get('skeptic')!.tag).toMatchObject({ mode: 'prioritize', included: 1, excludedUntagged: 0 });
  });

  it('REFUSES when the tag soul cannot load: no fallback to the base soul', async () => {
    h.getSoulDocument.mockImplementation(() => { throw new ActionableError({ goal: 'g', problem: 'tag soul missing', location: 'l', nextSteps: [] }); });
    const err = await refusal({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    expect(String((err as Error).message)).toMatch(/tag soul missing/);
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('REFUSES a tag soul of the wrong shape (e.g. a PovInfo view with no voice) instead of voicing it partially (t/4002)', async () => {
    const { voice: _dropped, anti_patterns: _alsoDropped, ...povInfoShaped } = TAG_SOUL;
    h.getSoulDocument.mockReturnValue(povInfoShaped);
    const err = await refusal({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    expect(err).toBeInstanceOf(ActionableError);
    expect(String((err as Error).message)).toMatch(/not a valid soul document.*voice/);
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('REFUSES an unregistered tag, and a tag whose POV is not requested', async () => {
    expect(String((await refusal({ pov: 'skeptic', tag: 'radical', mode: 'scope' }) as Error).message)).toMatch(/not registered/);
    expect(String((await refusal({ pov: 'safetyist', tag: 'critical', mode: 'scope' }) as Error).message)).toMatch(/safetyist has no tags/);
    expect(adapter.generateText).not.toHaveBeenCalled();
  });
});

describe('parseOpEdRequest (the live boundary)', () => {
  const req = (tagSelection?: unknown, povs: string[] = POVS) => ({ topic: 't', povs, params: { model: 'm', wordCount: 800, ...(tagSelection ? { tagSelection } : {}) } });

  it('accepts an untagged request and a registered tag for a requested POV, returning it unchanged', () => {
    const untagged = req();
    expect(parseOpEdRequest(untagged)).toBe(untagged);
    expect(() => parseOpEdRequest(req({ pov: 'skeptic', tag: 'critical', mode: 'prioritize' }))).not.toThrow();
  });

  it('rejects an unknown tag, a POV not in povs, a half selection and an extra key', () => {
    expect(() => parseOpEdRequest(req({ pov: 'skeptic', tag: 'radical', mode: 'scope' }))).toThrow(/not registered/);
    expect(() => parseOpEdRequest(req({ pov: 'skeptic', tag: 'critical', mode: 'scope' }, ['accelerationist']))).toThrow(/not one of the requested povs/);
    expect(() => parseOpEdRequest(req({ pov: 'skeptic', tag: 'critical' }))).toThrow(ActionableError);
    expect(() => parseOpEdRequest(req({ pov: 'skeptic', tag: 'critical', mode: 'scope', weight: 2 }))).toThrow(ActionableError);
  });
});

describe('the persisted set keeps the tag fields (strip regression, t/2890 class)', () => {
  it('round-trips params.tagSelection and member.tag; normalizes legacy soul on read', () => {
    const member = {
      pov: 'skeptic', status: 'complete', headline: 'H', subtitle: '', body: 'b', byline: '', disclosure: '', rhetorical_meta: '', wordCount: 1, grounding: [],
      tag: { pov: 'skeptic', tag: 'retired', mode: 'scope', included: 3, excludedUntagged: 9 },
      // Legacy shape: repo-relative file + sha field (pre-t/4007). Schema normalizes both on read.
      soul: { file: 'lib/debate/soul-docs/skeptic.retired.soul.json', sha: '0123456789abcdef' },
    };
    const set = {
      schema_version: 1, set_id: 's', topic: 't', created_at: 'now',
      params: { model: 'm', wordCount: 800, tagSelection: { pov: 'skeptic', tag: 'retired', mode: 'scope' } },
      opeds: [member],
    };
    const parsed = parseOpEdSet(set);
    expect(parsed.params.tagSelection).toEqual(set.params.tagSelection);
    expect(parsed.opeds[0].tag).toEqual(member.tag);
    // Normalized: lib/debate/soul-docs/ prefix stripped; sha mapped to hash.
    expect(parsed.opeds[0].soul).toEqual({ file: 'skeptic.retired.soul.json', hash: '0123456789abcdef' });
  });

  it('preserves a new-format soul record (fnv1a64 hash, soul-docs-relative file) unchanged', () => {
    const member = {
      pov: 'skeptic', status: 'complete', headline: 'H', subtitle: '', body: 'b', byline: '', disclosure: '', rhetorical_meta: '', wordCount: 1, grounding: [],
      soul: { file: 'skeptic.critical.soul.json', hash: 'fnv1a64:abcdef0123456789' },
    };
    const set = {
      schema_version: 1, set_id: 's', topic: 't', created_at: 'now',
      params: { model: 'm', wordCount: 800 },
      opeds: [member],
    };
    const parsed = parseOpEdSet(set);
    expect(parsed.opeds[0].soul).toEqual({ file: 'skeptic.critical.soul.json', hash: 'fnv1a64:abcdef0123456789' });
  });
});

describe('AppliedTagSchema: count meanings are pinned in the record (SO e/254#6 cond 3)', () => {
  it('describes both counts per mode, and says Prioritize excludedUntagged is not full coverage', () => {
    expect(AppliedTagSchema.shape.included.description).toBe(APPLIED_TAG_COUNT_MEANING.included);
    expect(AppliedTagSchema.shape.excludedUntagged.description).toBe(APPLIED_TAG_COUNT_MEANING.excludedUntagged);
    for (const meaning of Object.values(APPLIED_TAG_COUNT_MEANING)) {
      expect(meaning).toMatch(/scope:/);
      expect(meaning).toMatch(/prioritize:/);
    }
    expect(APPLIED_TAG_COUNT_MEANING.excludedUntagged).toMatch(/excludes nothing, NOT full coverage/);
  });
});

describe('op-ed tag selection: untagged runs', () => {
  it('carry no tag, and record each member\'s base soul file', async () => {
    const members = await run();
    // The untagged byline and disclosure are unchanged from before this feature.
    expect(members.get('skeptic')!.byline).toBe('By the Skeptic Camp, as modeled in AI Rosetta Stone');
    expect(members.get('skeptic')!.disclosure).toBe('Generated by AI Rosetta Stone to illustrate the Skeptic perspective. Not authored by any person; not for submission or publication.');
    for (const pov of POVS) {
      expect(members.get(pov)!.tag).toBeUndefined();
      expect(members.get(pov)!.soul).toMatchObject({ file: `${pov}.soul.json` });
      expect(members.get(pov)!.soul!.hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    // t/4007: loadSoulDoc now calls resolvePoverInfo(pov) for base-soul provenance, but never with a tag selection.
    expect(h.resolvePoverInfo).not.toHaveBeenCalledWith(expect.any(String), expect.any(Object));
  });
});
