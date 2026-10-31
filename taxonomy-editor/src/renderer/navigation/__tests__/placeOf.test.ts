// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { placeOf } from '../placeOf';
import type { TaxonomyStore } from '../../hooks/useTaxonomyStore';

describe('placeOf - per-tool open item resolvers', () => {
  const mockTaxonomyStore: TaxonomyStore = {
    activeTab: 'rosetta-stone',
    selectedNodeId: null,
  } as unknown as TaxonomyStore;
  // DebateSession.topic is an object, not a string (lib/debate/types/session.ts).
  const topic = (text: string) => ({ original: text, refined: null, final: text });

  describe('Debate place resolution', () => {
    it('returns library path when no debate is open', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'debate',
        debateStore: { activeDebate: null } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/debate');
      expect(place.placeKey).toBe('debate:none');
    });

    it('returns open debate path keyed off debate ID, not selectedNodeId', () => {
      const mockDebate = { id: 'debate-123', topic: topic('Should AI be regulated?') };
      const state = {
        taxonomyStore: { ...mockTaxonomyStore, selectedNodeId: 'taxonomy-node-456' },
        activeTab: 'debate',
        debateStore: { activeDebate: mockDebate } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/debate/debate-123');
      expect(place.placeKey).toBe('debate:debate-123');
      expect(place.label).toBe('Should AI be regulated?');
    });

    it('opening two different debates generates different placeKeys (pushes history)', () => {
      const debate1 = { id: 'debate-1', topic: topic('Should AI be regulated?') };
      const debate2 = { id: 'debate-2', topic: topic('AI and labor markets') };

      const state1 = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'debate',
        debateStore: { activeDebate: debate1 } as any,
      };
      const state2 = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'debate',
        debateStore: { activeDebate: debate2 } as any,
      };

      const place1 = placeOf(state1 as any);
      const place2 = placeOf(state2 as any);

      // Different debate IDs should have different placeKeys (triggers push)
      expect(place1.placeKey).toBe('debate:debate-1');
      expect(place2.placeKey).toBe('debate:debate-2');
      expect(place1.placeKey).not.toBe(place2.placeKey);
    });
  });

  describe('Chat place resolution', () => {
    it('returns open chat path keyed off chat ID', () => {
      const mockChat = { id: 'conv-42', topic: 'AI Safety' };
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'chat',
        chatStore: { activeChat: mockChat } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/chat/conv-42');
      expect(place.placeKey).toBe('chat:conv-42');
    });
  });

  describe('Op-Ed place resolution', () => {
    it('returns open op-ed path keyed off set ID', () => {
      const mockSets = [
        { set_id: 'set-1', topic: 'My Policy Analysis' },
        { set_id: 'set-2', topic: 'AI Regulation' },
      ];
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'opeds',
        opEdStore: { selectedSetId: 'set-1', sets: mockSets } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/opeds/set-1');
      expect(place.placeKey).toBe('opeds:set-1');
      expect(place.label).toBe('My Policy Analysis');
    });
  });

  describe('Inquiry place resolution', () => {
    it('returns the library path when no answer is open', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'inquiry',
        inquiryStore: { jobId: 'job-99', result: null } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/inquiry');
      expect(place.placeKey).toBe('inquiry:none');
    });

    it('returns open inquiry path keyed off the job ID when an answer is open', () => {
      // The inquiry store has no activeInquiry object: an answer is open when `result` is set.
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'inquiry',
        inquiryStore: {
          jobId: 'job-99',
          result: { request: { question: 'How does transformer attention work?' } },
        } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/inquiry/job-99');
      expect(place.placeKey).toBe('inquiry:job-99');
      expect(place.label).toBe('How does transformer attention work?');
    });
  });

  describe('Taxonomy place resolution (POV tabs)', () => {
    it('returns taxonomy path keyed off node ID, not debate/chat ID', () => {
      const mockDebate = { id: 'debate-123', topic: topic('Some debate') };
      const state = {
        taxonomyStore: { ...mockTaxonomyStore, activeTab: 'accelerationist', selectedNodeId: 'acc-001-042' },
        activeTab: 'accelerationist',
        debateStore: { activeDebate: mockDebate } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/taxonomy/acc?node=acc-001-042');
      expect(place.placeKey).toBe('taxonomy:acc-001-042');
      // Taxonomy place is independent of any open debate
    });
  });
});
