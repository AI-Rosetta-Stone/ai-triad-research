// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeEntry, normalizeSession, type NormalizerContext } from './chatNormalizer';
import type { ChatEntry, ChatSession } from '../types/chat';
import type { TaxonomyRef } from '../types/debate';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: vi.fn(() => ({ record: vi.fn() })),
}));

describe('chatNormalizer', () => {
  let context: NormalizerContext;

  const LABELS: Record<string, string> = {
    'acc-desires-033': 'Paradise Engineering',
    'saf-grounding-015': 'Value Alignment',
    'skp-beliefs-001': 'Superseded Node',
  };
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    context = {
      taxonomyLoaded: true,
      lookupLabel: (id: string) => LABELS[id] ?? null,
    };
  });

  const warnings = () => record.mock.calls.filter(([e]) => e.level === 'warn');

  describe('normalizeEntry: load gating and warnings (t/282)', () => {
    const entryWith = (node_id: string, label?: string): ChatEntry => ({
      id: 'e1', timestamp: '2026-06-08T10:00:00Z', speaker: 'accelerationist', content: 'x',
      taxonomy_refs: [{ node_id, relevance: 'r', ...(label ? { label } : {}) }],
    });

    it('does nothing while the taxonomy is loading: no backfill and no WARN', () => {
      context = { ...context, taxonomyLoaded: false };
      const entry = entryWith('acc-desires-033');
      normalizeEntry(entry, context);
      expect(entry.taxonomy_refs[0].label).toBeUndefined();
      expect(warnings()).toHaveLength(0);
    });

    it('keeps a ref label it already has', () => {
      const entry = entryWith('acc-desires-033', 'Kept');
      normalizeEntry(entry, context);
      expect(entry.taxonomy_refs[0].label).toBe('Kept');
    });

    it('resolves a superseded node through the lookup, so no WARN fires', () => {
      const entry = entryWith('skp-beliefs-001');
      normalizeEntry(entry, context);
      expect(entry.taxonomy_refs[0].label).toBe('Superseded Node');
      expect(warnings()).toHaveLength(0);
    });

    it('WARNs once for a taxonomy node that is missing from a loaded taxonomy', () => {
      const entry = entryWith('skp-beliefs-999');
      normalizeEntry(entry, context);
      expect(entry.taxonomy_refs[0].label).toBeUndefined();
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][0].data).toEqual({ node_id: 'skp-beliefs-999' });
    });

    it('does not WARN for policy (pol-*) or conflict ids, which live outside the taxonomy', () => {
      normalizeEntry(entryWith('pol-ai-safety-001'), context);
      normalizeEntry(entryWith('conflict-42'), context);
      expect(warnings()).toHaveLength(0);
    });
  });

  describe('normalizeEntry', () => {
    it('backfills missing ref labels from taxonomy', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-06-08T10:00:00Z',
        speaker: 'accelerationist',
        content: 'Test content',
        taxonomy_refs: [
          { node_id: 'acc-desires-033', relevance: 'Primary node' },
        ],
      };

      normalizeEntry(entry, context);

      expect(entry.taxonomy_refs[0].label).toBe('Paradise Engineering');
    });

    it('preserves existing ref labels', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-06-08T10:00:00Z',
        speaker: 'accelerationist',
        content: 'Test content',
        taxonomy_refs: [
          { node_id: 'acc-desires-033', label: 'Custom Label', relevance: 'Primary node' },
        ],
      };

      normalizeEntry(entry, context);

      expect(entry.taxonomy_refs[0].label).toBe('Custom Label');
    });

    it('does not add fallback label for nodes no longer in taxonomy', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-06-08T10:00:00Z',
        speaker: 'accelerationist',
        content: 'Test content',
        taxonomy_refs: [
          { node_id: 'skp-beliefs-999', relevance: 'Old node' },
        ],
      };

      normalizeEntry(entry, context);

      expect(entry.taxonomy_refs[0].label).toBeUndefined();
    });

    it('handles entries with no refs', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-06-08T10:00:00Z',
        speaker: 'user',
        content: 'Just a question',
        taxonomy_refs: [],
      };

      expect(() => normalizeEntry(entry, context)).not.toThrow();
      expect(entry.taxonomy_refs).toEqual([]);
    });

    it('preserves raw_prompt and raw_response fields', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-11-10T15:00:00Z',
        speaker: 'accelerationist',
        content: 'Response text',
        taxonomy_refs: [],
        raw_prompt: 'Original prompt',
        raw_response: 'Original response',
      };

      normalizeEntry(entry, context);

      expect(entry.raw_prompt).toBe('Original prompt');
      expect(entry.raw_response).toBe('Original response');
    });

    it('does not add raw_prompt/raw_response if missing', () => {
      const entry: ChatEntry = {
        id: 'e1',
        timestamp: '2026-06-08T10:00:00Z',
        speaker: 'accelerationist',
        content: 'Old response',
        taxonomy_refs: [],
      };

      normalizeEntry(entry, context);

      expect(entry.raw_prompt).toBeUndefined();
      expect(entry.raw_response).toBeUndefined();
    });
  });

  describe('normalizeSession', () => {
    it('normalizes all entries in a session', () => {
      const session: ChatSession = {
        id: 'chat-123',
        title: 'Old Chat',
        created_at: '2026-06-08T10:00:00Z',
        updated_at: '2026-06-08T10:05:00Z',
        mode: 'brainstorm',
        topic: 'Topic',
        pover: 'accelerationist',
        transcript: [
          {
            id: 'e1',
            timestamp: '2026-06-08T10:00:00Z',
            speaker: 'user',
            content: 'Question?',
            taxonomy_refs: [],
          },
          {
            id: 'e2',
            timestamp: '2026-06-08T10:01:00Z',
            speaker: 'accelerationist',
            content: 'Answer',
            taxonomy_refs: [
              { node_id: 'acc-desires-033', relevance: 'Primary' },
              { node_id: 'saf-grounding-015', relevance: 'Secondary' },
            ],
          },
        ],
      };

      normalizeSession(session, context);

      expect(session.transcript[1].taxonomy_refs[0].label).toBe('Paradise Engineering');
      expect(session.transcript[1].taxonomy_refs[1].label).toBe('Value Alignment');
    });

    it('logs normalization info to flight recorder', () => {
      const mockRecorder = { record: vi.fn() };
      vi.mocked(getGlobalRecorder).mockReturnValue(mockRecorder);

      const session: ChatSession = {
        id: 'chat-456',
        title: 'Test Chat',
        created_at: '2026-06-08T10:00:00Z',
        updated_at: '2026-06-08T10:00:00Z',
        mode: 'inform',
        topic: 'Topic',
        pover: 'safetyist',
        transcript: [
          {
            id: 'e1',
            timestamp: '2026-06-08T10:00:00Z',
            speaker: 'user',
            content: 'Q',
            taxonomy_refs: [],
          },
        ],
      };

      normalizeSession(session, context);

      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state.change',
          component: 'chat-store',
          level: 'info',
          data: expect.objectContaining({
            chat_id: 'chat-456',
            entry_count: 1,
            has_raw_fields: false,
          }),
        }),
      );
    });

    it('reports has_raw_fields=true when entries have raw fields', () => {
      const mockRecorder = { record: vi.fn() };
      vi.mocked(getGlobalRecorder).mockReturnValue(mockRecorder);

      const session: ChatSession = {
        id: 'chat-789',
        title: 'New Chat',
        created_at: '2026-11-10T15:00:00Z',
        updated_at: '2026-11-10T15:00:00Z',
        mode: 'decide',
        topic: 'Topic',
        pover: 'skeptic',
        transcript: [
          {
            id: 'e1',
            timestamp: '2026-11-10T15:00:00Z',
            speaker: 'user',
            content: 'Q',
            taxonomy_refs: [],
            raw_prompt: 'Prompt',
            raw_response: 'Response',
          },
        ],
      };

      normalizeSession(session, context);

      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            has_raw_fields: true,
          }),
        }),
      );
    });
  });
});
