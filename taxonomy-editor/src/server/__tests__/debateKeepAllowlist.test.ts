// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196#25: the debate community allowlist is the 13 keys Security re-reviews. Transcript entries,
// neutral_evaluations and adaptive_staging are projected structurally. One test per KEEP group, plus
// tests that owner-only fields and structural drops hold.

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

const TRANSCRIPT_ENTRY = {
  id: 'turn-1',
  timestamp: '2026-01-01T12:00:00Z',
  type: 'opening',
  speaker: 'skeptic',
  content: 'Opening statement.',
  taxonomy_refs: [{ node_id: 'saf-belief-001', label: 'Existential Risk', relevance: 'high' }],
  summaries: 'a summary',
  display_tier: 'main',
  caveats: [],
  status: 'complete',
  errorMessage: null,
  // Engine and owner-only entry keys: none may reach the community copy.
  model: 'claude-opus',
  addressing: 'accelerationist',
  intervention_metadata: { source: 'PRIVATE INTERVENTION' },
  provider_model: 'claude-opus-private',
  degraded: false,
  metadata: {
    policy_refs: ['pol-1'],
    fact_check: { verdict: 'ok' },
    moderator_trace: 'PRIVATE MODERATOR TRACE',
    injection_manifest: 'PRIVATE INJECTION',
    key_assumptions: 'PRIVATE ASSUMPTIONS',
  },
};

const KEEP_FIELDS = {
  id: 'deb-1',
  title: 'AI Safety Debate',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  topic: { original: 'Should AI be regulated?', final: 'Should AI be regulated?' },
  phase: 'debate',
  audience: 'policymakers',
  active_povers: ['skeptic', 'accelerationist'],
  source_type: 'topic',
  argument_network: { nodes: [], edges: [] },
  neutral_evaluations: [{
    checkpoint: 'final',
    timestamp: '2026-01-02T00:00:00Z',
    cruxes: [],
    claims: [],
    overall_assessment: { debate_is_engaging_real_disagreement: true },
    diagnostics_prompt: 'PRIVATE EVALUATOR PROMPT',
    diagnostics_raw_response: 'PRIVATE RAW RESPONSE',
    diagnostics_response_time_ms: 1234,
  }],
  adaptive_staging: {
    enabled: true,
    pacing: 'moderate',
    step_mode: true,
    phase_state: { current_phase: 'debate', rounds: 'PRIVATE ROUNDS' },
    phase_bounds_override: { max: 'PRIVATE BOUNDS' },
  },
  transcript: [TRANSCRIPT_ENTRY],
};

// Owner-only: every key not in the 13, including the ones removed in t/196#25.
const OWNER_ONLY_FIELDS = {
  stages: [{ name: 'context-rot', prompt: 'PRIVATE PROMPT' }],
  prompt_config: { system: 'PRIVATE SYSTEM PROMPT' },
  origin: { mode: 'cli', command: 'debate --secret', config_summary: { key: 'v' } },
  metadata: { anything: 'PRIVATE METADATA' },
  diagnostics: { turn_count: 2 },
  position_drift: [{ pov: 'skeptic', delta: 0.1 }],
  convergence_signals: [{ turn: 1 }],
  debate_model: 'claude-opus-owner-only',
  speaker_models: { skeptic: 'claude-opus-owner-only' },
  model_tier: 'standard',
  protocol_id: 'standard-v1',
  opening_order: ['skeptic', 'accelerationist'],
  commitments: [{ pov: 'skeptic' }],
  context_summaries: [{ s: 'SOURCE SUMMARY' }],
  source_content: 'PRIVATE SOURCE MATERIAL',
  source_ref: 'PRIVATE SOURCE REF',
  document_analysis: { doc: 'PRIVATE DOC' },
  config: { run: 'PRIVATE RUN CONFIG' },
  user_is_pover: true,
  debate_temperature: 0.8,
  model_pool: ['private-model'],
  run_id: 'run-secret',
  unknown_future_field: 'NEW FIELD',
};

describe('Debate community allowlist: 13 KEEP keys (t/196#25)', () => {
  beforeEach(() => files.clear());

  it('identity and list fields survive (title, created_at, updated_at, topic, phase); id is re-minted', async () => {
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

  it('argument_network survives unchanged', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('argument_network', { nodes: [], edges: [] });
  });

  it('neutral_evaluations keep their evaluation fields and lose every diagnostics_* key', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    const evaluation = (copy.neutral_evaluations as Array<Record<string, unknown>>)[0];
    expect(evaluation).toHaveProperty('checkpoint', 'final');
    expect(evaluation).toHaveProperty('overall_assessment');
    expect(evaluation).not.toHaveProperty('diagnostics_prompt');
    expect(evaluation).not.toHaveProperty('diagnostics_raw_response');
    expect(evaluation).not.toHaveProperty('diagnostics_response_time_ms');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE EVALUATOR PROMPT');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE RAW RESPONSE');
  });

  it('adaptive_staging is narrowed to enabled, step_mode and phase_state.current_phase', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy.adaptive_staging).toEqual({ enabled: true, step_mode: true, phase_state: { current_phase: 'debate' } });
    expect(JSON.stringify(copy)).not.toContain('PRIVATE ROUNDS');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE BOUNDS');
  });

  it('transcript entries keep only reader keys and their narrowed metadata', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    const entry = (copy.transcript as Array<Record<string, unknown>>)[0];
    expect(entry).toMatchObject({ id: 'turn-1', speaker: 'skeptic', content: 'Opening statement.', status: 'complete' });
    expect(entry).toHaveProperty('taxonomy_refs');
    expect(entry).toHaveProperty('metadata', { policy_refs: ['pol-1'], fact_check: { verdict: 'ok' } });
    for (const k of ['model', 'addressing', 'intervention_metadata', 'provider_model', 'degraded']) {
      expect(entry, `transcript key "${k}" leaked`).not.toHaveProperty(k);
    }
    expect(JSON.stringify(copy)).not.toContain('PRIVATE MODERATOR TRACE');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE INJECTION');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE ASSUMPTIONS');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE INTERVENTION');
  });

  it('no raw_prompt or raw_response key survives in any debate transcript entry', async () => {
    seed('deb-1', {
      ...KEEP_FIELDS,
      transcript: [
        { ...TRANSCRIPT_ENTRY, raw_prompt: 'RAW PROMPT', raw_response: 'RAW RESPONSE', metadata: { raw_prompt: 'RAW PROMPT IN META' } },
      ],
    });
    const copy = published((await approveSubmission('deb-1')).communityId);
    const entry = (copy.transcript as Array<Record<string, unknown>>)[0];
    expect(entry).not.toHaveProperty('raw_prompt');
    expect(entry).not.toHaveProperty('raw_response');
    expect(JSON.stringify(copy)).not.toContain('RAW PROMPT');
    expect(JSON.stringify(copy)).not.toContain('RAW RESPONSE');
  });

  it('attribution is added by the server (community_metadata)', async () => {
    seed('deb-1', KEEP_FIELDS);
    const copy = published((await approveSubmission('deb-1')).communityId);
    expect(copy).toHaveProperty('community_metadata');
  });

  it('every OWNER-ONLY field is stripped, including the t/196#25 removals and unknown future fields', async () => {
    seed('deb-1', { ...KEEP_FIELDS, ...OWNER_ONLY_FIELDS });
    const copy = published((await approveSubmission('deb-1')).communityId);
    for (const k of Object.keys(OWNER_ONLY_FIELDS)) {
      expect(copy, `owner-only field "${k}" leaked`).not.toHaveProperty(k);
    }
    expect(JSON.stringify(copy)).not.toContain('PRIVATE');
    expect(JSON.stringify(copy)).not.toContain('NEW FIELD');
    expect(JSON.stringify(copy)).not.toContain('owner-only');
  });
});
