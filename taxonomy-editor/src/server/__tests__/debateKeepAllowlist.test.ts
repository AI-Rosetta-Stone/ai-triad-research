// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196#21 table, ruled in t/196#23: the debate community allowlist is the 19 KEEP fields.
// One test per KEEP group, plus one that every OWNER-ONLY field is stripped.

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

function seed(id: string, data: Record<string, unknown>) {
  files.set(normalize(`/data/community/_submissions/sub-${id}.json`), JSON.stringify({ id, type: 'debate', status: 'pending', submittedBy: 'alice', data }));
}

function published(communityId: string): Record<string, unknown> {
  const key = [...files.keys()].find(k => k.startsWith('/data/community/') && !k.includes('_submissions') && k.endsWith(`${communityId}.json`));
  expect(key, `no community copy written for ${communityId}`).toBeDefined();
  return JSON.parse(files.get(key!)!) as Record<string, unknown>;
}

// A realistic debate record: every KEEP field, and every OWNER-ONLY field with a sentinel value.
const KEEP_FIELDS = {
  id: 'deb-1',
  title: 'AI Safety Debate',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  topic: { original: 'Should AI be regulated?', final: 'Should AI be regulated?' },
  phase: 'debate',
  audience: 'policymakers',
  active_povers: ['skeptic', 'accelerationist'],
  argument_network: { nodes: [] },
  convergence_signals: [{ turn: 1 }],
  position_drift: [{ pov: 'skeptic', delta: 0.1 }],
  neutral_evaluations: [{ score: 3 }],
  source_type: 'topic',
  debate_model: 'claude-opus',
  speaker_models: { skeptic: 'claude-opus' },
  model_tier: 'standard',
  protocol_id: 'standard-v1',
  adaptive_staging: false,
  transcript: [{
    id: 'turn-1',
    timestamp: '2026-01-01T12:00:00Z',
    type: 'opening',
    speaker: 'skeptic',
    content: 'Opening statement.',
    taxonomy_refs: [{ node_id: 'saf-belief-001', label: 'Existential Risk', relevance: 'high' }],
    summaries: 'a summary',
    display_tier: 'main',
    caveats: [],
    model: 'claude-opus',
    addressing: 'accelerationist',
    intervention_metadata: null,
    status: 'complete',
    errorMessage: null,
    provider_model: 'claude-opus',
    degraded: false,
    policy_refs: [],
  }],
};

const OWNER_ONLY_FIELDS = {
  stages: [{ name: 'context-rot', prompt: 'PRIVATE PROMPT' }],
  prompt_config: { system: 'PRIVATE SYSTEM PROMPT' },
  origin: { mode: 'cli', command: 'debate --secret', config_summary: { key: 'v' } },
  metadata: { anything: 'PRIVATE METADATA' },
  diagnostics: { turn_count: 2 },
  opening_order: ['skeptic', 'accelerationist'],
  commitments: [{ pov: 'skeptic' }],
  convergence_tracker: { x: 1 },
  qbaf_timeline: [{ t: 1 }],
  context_summaries: [{ s: 'SOURCE SUMMARY' }],
  source_content: 'PRIVATE SOURCE MATERIAL',
  source_ref: 'PRIVATE SOURCE REF',
  document_analysis: { doc: 'PRIVATE DOC' },
  config: { run: 'PRIVATE RUN CONFIG' },
  user_is_pover: true,
  debate_temperature: 0.8,
  model_pool: ['private-model'],
  crux_tracker: { x: 1 },
  run_id: 'run-secret',
  unknown_future_field: 'NEW FIELD',
};

describe('Debate community allowlist: KEEP groups (t/196#21, t/196#23)', () => {
  beforeEach(() => files.clear());

  it('identity and list fields survive (id, title, created_at, updated_at, topic, phase)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    for (const k of ['title', 'created_at', 'updated_at', 'topic', 'phase']) {
      expect(copy).toHaveProperty(k, (KEEP_FIELDS as Record<string, unknown>)[k]);
    }
    // id is replaced by a fresh community UUID; the source id survives as community_metadata.original_id
    expect(copy.id).not.toBe('deb-1');
    expect(copy.community_metadata).toHaveProperty('original_id', 'deb-1');
  });

  it('participation fields survive (audience, active_povers, source_type)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('audience', 'policymakers');
    expect(copy).toHaveProperty('active_povers', ['skeptic', 'accelerationist']);
    expect(copy).toHaveProperty('source_type', 'topic');
  });

  it('model label fields survive (debate_model, speaker_models, model_tier, protocol_id, adaptive_staging)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('debate_model', 'claude-opus');
    expect(copy).toHaveProperty('speaker_models', { skeptic: 'claude-opus' });
    expect(copy).toHaveProperty('model_tier', 'standard');
    expect(copy).toHaveProperty('protocol_id', 'standard-v1');
    expect(copy).toHaveProperty('adaptive_staging', false);
  });

  it('analysis fields survive (argument_network, convergence_signals, position_drift, neutral_evaluations)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('argument_network', { nodes: [] });
    expect(copy).toHaveProperty('convergence_signals', [{ turn: 1 }]);
    expect(copy).toHaveProperty('position_drift', [{ pov: 'skeptic', delta: 0.1 }]);
    expect(copy).toHaveProperty('neutral_evaluations', [{ score: 3 }]);
  });

  it('transcript keeps its entry fields and never carries raw_prompt or raw_response', async () => {
    seed('deb-1', { ...KEEP_FIELDS, transcript: [{ ...KEEP_FIELDS.transcript[0], raw_prompt: 'RAW PROMPT', raw_response: 'RAW RESPONSE' }] });
    const copy = published((await approveSubmission('deb-1')).communityId);
    const entry = (copy.transcript as Array<Record<string, unknown>>)[0];
    expect(entry).toHaveProperty('content', 'Opening statement.');
    expect(entry).toHaveProperty('taxonomy_refs');
    expect(entry).not.toHaveProperty('raw_prompt');
    expect(entry).not.toHaveProperty('raw_response');
    expect(JSON.stringify(copy)).not.toContain('RAW PROMPT');
  });

  it('attribution is added by the server (community_metadata)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('community_metadata');
  });

  it('every OWNER-ONLY field is stripped, including unknown future fields', async () => {
    seed('deb-1', { ...KEEP_FIELDS, ...OWNER_ONLY_FIELDS });
    const copy = published((await approveSubmission('deb-1')).communityId);
    for (const k of Object.keys(OWNER_ONLY_FIELDS)) {
      expect(copy, `owner-only field "${k}" leaked`).not.toHaveProperty(k);
    }
    expect(JSON.stringify(copy)).not.toContain('PRIVATE');
    expect(JSON.stringify(copy)).not.toContain('NEW FIELD');
  });
});
