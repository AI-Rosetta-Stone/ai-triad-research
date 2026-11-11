// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196: Test that community sanitization allowlist preserves all required fields and exposes
// fields per PI decision t/345 (raw_prompt/raw_response are public). Verifies that approved items
// render correctly in list, detail, and copy paths without losing critical fields or leaking unknown fields.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DebateSession } from '../../../lib/debate/types/session.js';
import type { OpEdSet } from '../../../lib/oped/types.js';

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

function seed(id: string, type: string, data: Record<string, unknown>) {
  files.set(normalize(`/data/community/_submissions/sub-${id}.json`), JSON.stringify({ id, type, status: 'pending', submittedBy: 'alice', data }));
}

function published(communityId: string): Record<string, unknown> {
  const key = [...files.keys()].find(k => k.startsWith('/data/community/') && !k.includes('_submissions') && k.endsWith(`${communityId}.json`));
  expect(key, `no community copy written for ${communityId}`).toBeDefined();
  return JSON.parse(files.get(key!)!) as Record<string, unknown>;
}

describe('Community allowlist projection (t/196)', () => {
  beforeEach(() => files.clear());

  describe('Chat: required fields survive, raw fields exposed per t/345', () => {
    it('realistic chat preserves list/detail/copy fields and exposes raw_prompt/raw_response', async () => {
      const chatData = {
        id: 'chat-1',
        title: 'Policy Discussion',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        mode: 'inform',
        topic: 'AI Regulation',
        pover: 'skeptic',
        chat_model: 'gpt-4',
        temperature: 0.7,
        transcript: [
          {
            id: 'entry-1',
            timestamp: '2026-01-01T12:00:00Z',
            speaker: 'skeptic',
            content: 'Here is my analysis...',
            taxonomy_refs: [{ node_id: 'acc-belief-001', label: 'Alignment', relevance: 'high' }],
            raw_prompt: 'FULL CONTEXT: [user document content]', // t/345: now public
            raw_response: 'Raw model output before filtering', // t/345: now public
          },
        ],
      };

      seed('chat-1', 'chat', chatData);
      const { communityId } = await approveSubmission('chat-1');
      const copy = published(communityId);

      // List fields must survive
      expect(copy).toHaveProperty('title', 'Policy Discussion');
      expect(copy).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
      expect(copy).toHaveProperty('updated_at', '2026-01-02T00:00:00Z');
      expect(copy).toHaveProperty('mode', 'inform');
      expect(copy).toHaveProperty('topic', 'AI Regulation');
      expect(copy).toHaveProperty('pover', 'skeptic');
      expect(copy).toHaveProperty('chat_model', 'gpt-4');
      expect(copy).toHaveProperty('temperature', 0.7);

      // Detail: transcript must survive with all allowed fields including raw fields (t/345)
      const transcript = copy.transcript as any[];
      expect(transcript).toBeDefined();
      expect(transcript).toHaveLength(1);
      expect(transcript[0]).toHaveProperty('id', 'entry-1');
      expect(transcript[0]).toHaveProperty('speaker', 'skeptic');
      expect(transcript[0]).toHaveProperty('content', 'Here is my analysis...');
      expect(transcript[0]).toHaveProperty('taxonomy_refs');
      
      // t/345: raw_prompt and raw_response are now public
      expect(transcript[0]).toHaveProperty('raw_prompt', 'FULL CONTEXT: [user document content]');
      expect(transcript[0]).toHaveProperty('raw_response', 'Raw model output before filtering');
    });

    it('strips unknown/unlisted fields from chat', async () => {
      const chatData = {
        id: 'chat-2',
        title: 'Test Chat',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        mode: 'brainstorm',
        topic: 'Test',
        pover: 'accelerationist',
        pov_tag: 'test-tag', // now in allowlist (t/196#11)
        tag_mode: 'flag', // now in allowlist (t/196#11)
        transcript: [],
        unknown_field_should_drop: 'this should not appear',
        unlisted_field: 'should be dropped',
      };

      seed('chat-2', 'chat', chatData);
      const { communityId } = await approveSubmission('chat-2');
      const copy = published(communityId);

      // Allowlisted fields survive
      expect(copy).toHaveProperty('title', 'Test Chat');
      expect(copy).toHaveProperty('mode', 'brainstorm');
      expect(copy).toHaveProperty('pov_tag', 'test-tag');
      expect(copy).toHaveProperty('tag_mode', 'flag');

      // Unlisted fields are stripped
      expect(copy).not.toHaveProperty('unknown_field_should_drop');
      expect(copy).not.toHaveProperty('unlisted_field');
      expect(JSON.stringify(copy)).not.toContain('unlisted');
    });
  });

  describe('Debate: required fields survive, structural projection applied', () => {
    it('realistic debate preserves list/detail/copy fields and diagnostic stages', async () => {
      const debateData = {
        id: 'debate-1',
        title: 'AI Safety Debate',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        phase: 'debate',
        topic: {
          original: 'Should AI systems be regulated?',
          final: 'Should AI systems be regulated?',
        },
        source_type: 'topic',
        source_ref: '',
        source_content: '',
        active_povers: ['skeptic', 'accelerationist'],
        debate_model: 'claude-opus',
        debate_temperature: 0.8,
        opening_order: ['skeptic', 'accelerationist'],
        argument_network: {},
        transcript: [
          {
            id: 'turn-1',
            timestamp: '2026-01-01T12:00:00Z',
            type: 'opening',
            speaker: 'skeptic',
            content: 'Here is the skeptic perspective...',
            taxonomy_refs: [{ node_id: 'saf-belief-001', label: 'Existential Risk', relevance: 'high' }],
          },
        ],
        context_summaries: [],
        audience: 'policymakers',
        prompt_config: {},
        gap_injections: [],
        user_is_pover: false,
        diagnostics: { turn_count: 2 }, // Diagnostic metadata is allowed
      };

      seed('debate-1', 'debate', debateData);
      const { communityId } = await approveSubmission('debate-1');
      const copy = published(communityId);

      // List fields must survive
      expect(copy).toHaveProperty('title', 'AI Safety Debate');
      expect(copy).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
      expect(copy).toHaveProperty('updated_at', '2026-01-02T00:00:00Z');
      expect(copy).toHaveProperty('phase', 'debate');
      expect(copy).toHaveProperty('debate_model', 'claude-opus');

      // Detail: active_povers and transcript must survive with allowed fields
      expect(copy).toHaveProperty('active_povers');
      expect((copy.active_povers as any[])).toContain('skeptic');
      expect(copy).toHaveProperty('opening_order');
      expect(copy).toHaveProperty('debate_temperature', 0.8);
      expect(copy).toHaveProperty('argument_network');
      
      // t/171: debate diagnostic metadata must survive (unlike op-ed stages which are source material)
      expect(copy).toHaveProperty('diagnostics');
      expect((copy.diagnostics as any)).toHaveProperty('turn_count', 2);

      const transcript = copy.transcript as any[];
      expect(transcript).toBeDefined();
      expect(transcript).toHaveLength(1);
      expect(transcript[0]).toHaveProperty('id', 'turn-1');
      expect(transcript[0]).toHaveProperty('type', 'opening');
      expect(transcript[0]).toHaveProperty('speaker', 'skeptic');
      expect(transcript[0]).toHaveProperty('content');
      expect(transcript[0]).toHaveProperty('taxonomy_refs');
    });
  });

  describe('Op-Ed: required fields survive, stages are stripped', () => {
    it('realistic op-ed preserves list/detail/copy fields and strips stages', async () => {
      const opedData = {
        schema_version: 1,
        set_id: 'oped-set-1',
        id: 'oped-1-orig', // original id, will be re-minted
        topic: 'AI Governance Frameworks',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        params: {
          wordCount: 800,
          outlet: 'Policy Brief',
          model: 'gpt-4',
        },
        opeds: [
          {
            pov: 'accelerationist',
            status: 'complete',
            headline: 'The Case for Rapid AI Deployment',
            subtitle: 'Why delay is risky',
            body: 'Full op-ed text here...',
            byline: 'Dr. Smith',
            disclosure: 'No conflicts',
            rhetorical_meta: 'tone analysis',
            wordCount: 800,
            grounding: [
              {
                node_id: 'acc-belief-001',
                label: 'Economic Growth',
                category: 'belief',
                pov: 'accelerationist',
                relevance: 'high',
                how_reflected: 'throughout',
              },
            ],
            stages: [
              {
                stage: 'generation',
                attempt: 1,
                model: 'gpt-4',
                prompt: 'USER SOURCE MATERIAL: confidential briefing',
                output: 'generated text',
              },
            ],
          },
        ],
      };

      seed('oped-1', 'oped', opedData);
      const { communityId } = await approveSubmission('oped-1');
      const copy = published(communityId);

      // List fields must survive
      expect(copy).toHaveProperty('topic', 'AI Governance Frameworks');
      expect(copy).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
      expect(copy).toHaveProperty('schema_version', 1);
      expect(copy).toHaveProperty('set_id', 'oped-set-1');

      // Copy: params and opeds fields must survive
      expect(copy).toHaveProperty('params');
      expect((copy.params as any).outlet).toBe('Policy Brief');

      const opeds = copy.opeds as any[];
      expect(opeds).toBeDefined();
      expect(opeds).toHaveLength(1);
      expect(opeds[0]).toHaveProperty('pov', 'accelerationist');
      expect(opeds[0]).toHaveProperty('headline', 'The Case for Rapid AI Deployment');
      expect(opeds[0]).toHaveProperty('body', 'Full op-ed text here...');
      expect(opeds[0]).toHaveProperty('grounding');

      // Stages must be stripped (contain source material)
      expect(opeds[0]).not.toHaveProperty('stages');
      expect(JSON.stringify(copy)).not.toContain('USER SOURCE MATERIAL');
      expect(JSON.stringify(copy)).not.toContain('confidential briefing');
    });
  });
});
