// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196 (TL p/77#99): asserts what the committed debate allowlist (48730f380, 13 keys) allows today, derived
// from the ruling t/196#25 and t/196#23. It is written from the code's behaviour, not from any earlier edit.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = new Map<string, string>();
const normalize = (p: string) => p.replace(/\\/g, '/');

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
    listDirectory: vi.fn(async (dir: string) => {
      const prefix = `${normalize(dir)}/`;
      return [...new Set([...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)))];
    }),
  }),
  assertSafeId: (id: string, label: string) => {
    if (!id || id.includes('..') || id.includes('/')) throw new Error(`Unsafe ${label}: ${id}`);
  },
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));

import { approveSubmission } from '../community/community.js';

/** The 13 keys ruled in t/196#25 (Security re-review), as committed in 48730f380. */
const KEEP_SET = [
  'id', 'title', 'created_at', 'updated_at', 'topic', 'phase', 'audience', 'active_povers',
  'transcript', 'argument_network', 'neutral_evaluations', 'source_type', 'adaptive_staging',
].sort();

/** Keys the ruling removes or keeps out: owner-only, or model ids not covered by t/345 (t/196#23, #25). */
const OWNER_ONLY = [
  'stages', 'prompt_config', 'origin', 'metadata', 'diagnostics', 'position_drift', 'convergence_signals',
  'debate_model', 'speaker_models', 'model_tier', 'protocol_id', 'opening_order', 'commitments',
  'context_summaries', 'source_content', 'source_ref', 'document_analysis', 'config', 'user_is_pover',
  'debate_temperature', 'model_pool', 'run_id', 'unknown_future_field',
];

function seed(id: string, data: Record<string, unknown>) {
  files.set(normalize(`/data/community/_submissions/sub-${id}.json`), JSON.stringify({ id, type: 'debate', status: 'pending', submittedBy: 'alice', data }));
}

function published(communityId: string): Record<string, unknown> {
  const key = [...files.keys()].find(k => k.startsWith('/data/community/') && !k.includes('_submissions') && k.endsWith(`${communityId}.json`));
  expect(key, `no community copy written for ${communityId}`).toBeDefined();
  return JSON.parse(files.get(key!)!) as Record<string, unknown>;
}

/** A debate with every KEEP key set to a realistic value and every OWNER_ONLY key set to a sentinel. */
function debateWithAllKeys(): Record<string, unknown> {
  const owner: Record<string, unknown> = {};
  for (const k of OWNER_ONLY) owner[k] = `OWNER_ONLY_${k}`;
  return {
    ...owner,
    id: 'deb-keep',
    title: 'Keep set debate',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    topic: { original: 'Q', final: 'Q' },
    phase: 'debate',
    audience: 'policymakers',
    active_povers: ['skeptic', 'accelerationist'],
    source_type: 'topic',
    argument_network: { nodes: [], edges: [] },
    neutral_evaluations: [{ checkpoint: 'final', timestamp: '2026-01-02T00:00:00Z', cruxes: [], claims: [], overall_assessment: {} }],
    adaptive_staging: { enabled: true, pacing: 'moderate', step_mode: false, phase_state: { current_phase: 'debate', rounds: 'OWNER_ONLY_rounds' } },
    transcript: [{ id: 't1', timestamp: '2026-01-01T00:00:00Z', type: 'opening', speaker: 'skeptic', content: 'Opening.', taxonomy_refs: [] }],
  };
}

describe('Debate community allowlist: what the committed code allows (t/196#25, 48730f380)', () => {
  beforeEach(() => files.clear());

  it('the published debate carries exactly the 13 KEEP keys plus the server-added community_metadata', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    const keys = Object.keys(copy).sort();
    expect(keys).toEqual([...KEEP_SET, 'community_metadata'].sort());
  });

  it('every OWNER_ONLY key is absent from the published debate, by key', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    for (const k of OWNER_ONLY) {
      expect(Object.prototype.hasOwnProperty.call(copy, k), `owner-only key "${k}" published`).toBe(false);
    }
  });

  it('no OWNER_ONLY value appears anywhere in the published debate', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    expect(JSON.stringify(copy)).not.toContain('OWNER_ONLY_');
  });

  it('identity and list keys survive with their values (title, created_at, updated_at, topic, phase)', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    expect(copy).toMatchObject({ title: 'Keep set debate', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', phase: 'debate' });
    expect(copy.topic).toEqual({ original: 'Q', final: 'Q' });
  });

  it('participation keys survive with their values (audience, active_povers, source_type)', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    expect(copy).toMatchObject({ audience: 'policymakers', active_povers: ['skeptic', 'accelerationist'], source_type: 'topic' });
  });

  it('argument_network survives unchanged', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    expect(copy.argument_network).toEqual({ nodes: [], edges: [] });
  });

  it('neutral_evaluations keeps its evaluation keys only', async () => {
    const data = debateWithAllKeys();
    (data.neutral_evaluations as Array<Record<string, unknown>>)[0].diagnostics_prompt = 'DIAG';
    seed('deb-keep', data);
    const copy = published((await approveSubmission('deb-keep')).communityId);
    const ev = (copy.neutral_evaluations as Array<Record<string, unknown>>)[0];
    expect(Object.keys(ev).sort()).toEqual(['checkpoint', 'cruxes', 'claims', 'overall_assessment', 'timestamp'].sort());
  });

  it('adaptive_staging is narrowed to enabled, step_mode and phase_state.current_phase', async () => {
    seed('deb-keep', debateWithAllKeys());
    const copy = published((await approveSubmission('deb-keep')).communityId);
    expect(copy.adaptive_staging).toEqual({ enabled: true, step_mode: false, phase_state: { current_phase: 'debate' } });
  });

  it('transcript entries keep their reader keys and no raw_prompt or raw_response', async () => {
    const data = debateWithAllKeys();
    (data.transcript as Array<Record<string, unknown>>)[0].raw_prompt = 'RAW';
    (data.transcript as Array<Record<string, unknown>>)[0].raw_response = 'RAW';
    seed('deb-keep', data);
    const copy = published((await approveSubmission('deb-keep')).communityId);
    const entry = (copy.transcript as Array<Record<string, unknown>>)[0];
    expect(entry).toMatchObject({ id: 't1', speaker: 'skeptic', content: 'Opening.' });
    expect(Object.prototype.hasOwnProperty.call(entry, 'raw_prompt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, 'raw_response')).toBe(false);
  });
});
