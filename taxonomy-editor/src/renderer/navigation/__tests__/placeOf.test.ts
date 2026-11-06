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
      expect(place.label).toBe('Debate: Should AI be regulated?');
    });

    // t/4888: DebateTab's Community selection has no My-side counterpart on the resolver —
    // it's a separate field, checked only when no My debate is active.
    it('returns open debate path keyed off activeCommunityDebate when a community debate is open (t/4888)', () => {
      const mockCommunityDebate = { id: 'community-3', title: 'Should labs self-regulate?' };
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'debate',
        debateStore: { activeDebate: null, activeCommunityDebate: mockCommunityDebate } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/debate/community-3?community=1');
      expect(place.placeKey).toBe('debate:community-3');
      expect(place.label).toBe('Debate: Should labs self-regulate?');
      expect(place.crumbs[0]).toEqual({ text: 'Debate', href: '/debate' });
    });

    // t/4888#3 (Design review): opening Community must not clear activeDebate (a round could
    // still be in flight there), so the resolver — not a clear-on-select side effect — is what
    // picks the right one: activeCommunityDebate wins when set.
    it('prefers activeCommunityDebate over a coexisting activeDebate', () => {
      const mockDebate = { id: 'debate-123', topic: topic('Should AI be regulated?') };
      const mockCommunityDebate = { id: 'community-3', title: 'Should labs self-regulate?' };
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'debate',
        debateStore: { activeDebate: mockDebate, activeCommunityDebate: mockCommunityDebate } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/debate/community-3?community=1');
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
        chatStore: { activeChat: mockChat, activeCommunityChat: null } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/chat/conv-42');
      expect(place.placeKey).toBe('chat:conv-42');
    });

    // t/4888: ChatTab's Community selection has no `jobId`-style counterpart on the My side —
    // it's a separate field, checked only when no My chat is active.
    it('returns open chat path keyed off activeCommunityChat when a community chat is open (t/4888)', () => {
      const mockCommunityChat = { id: 'community-7', title: 'A shared debate recap' };
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'chat',
        chatStore: { activeChat: null, activeCommunityChat: mockCommunityChat } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/chat/community-7?community=1');
      expect(place.placeKey).toBe('chat:community-7');
      expect(place.label).toBe('Chat: A shared debate recap');
      expect(place.crumbs[0]).toEqual({ text: 'Chat', href: '/chat' });
    });

    // t/4888#3 (Design review): opening Community must not clear activeChat (a reply could
    // still be generating there, t/4687#1), so the resolver — not a clear-on-select side
    // effect — is what picks the right one: activeCommunityChat wins when set.
    it('prefers activeCommunityChat over a coexisting activeChat', () => {
      const mockChat = { id: 'conv-42', topic: 'AI Safety' };
      const mockCommunityChat = { id: 'community-7', title: 'A shared debate recap' };
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'chat',
        chatStore: { activeChat: mockChat, activeCommunityChat: mockCommunityChat } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/chat/community-7?community=1');
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
        opEdStore: { selectedSetId: 'set-1', sets: mockSets, selectedSetTitle: null, selectedSetIsCommunity: false } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/opeds/set-1');
      expect(place.placeKey).toBe('opeds:set-1');
      expect(place.label).toBe('Op-Ed Studies: My Policy Analysis');
    });

    // t/4888: `sets` (My-only) has no row for a community set — its title and community-ness
    // come from selectedSetTitle/selectedSetIsCommunity instead (set by openCommunity()).
    it('returns open op-ed path keyed off selectedSetTitle when a community set is open (t/4888)', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'opeds',
        opEdStore: { selectedSetId: 'c-9', sets: [], selectedSetTitle: 'A Shared Take on Export Controls', selectedSetIsCommunity: true } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/opeds/c-9?community=1');
      expect(place.placeKey).toBe('opeds:c-9');
      expect(place.label).toBe('Op-Ed Studies: A Shared Take on Export Controls');
      expect(place.crumbs[0]).toEqual({ text: 'Op-Ed Studies', href: '/opeds' });
    });

    it('a My set found in `sets` wins over a stale selectedSetIsCommunity flag', () => {
      const mockSets = [{ set_id: 'set-1', topic: 'My Policy Analysis' }];
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'opeds',
        opEdStore: { selectedSetId: 'set-1', sets: mockSets, selectedSetTitle: 'stale community title', selectedSetIsCommunity: true } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/opeds/set-1');
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

    // t/4888 (Design review, prod regression, t/4888#6): openList() deliberately does NOT clear
    // result/jobId/communityResultId — a My job kept running in the background while the user
    // browses the list must still be there if they come back — so a stale `result` alone can't
    // tell "item open" from "went up, job still in flight". Before this, going up left the
    // breadcrumb (and the URL, via the nav subscriber's placeKey-unchanged check) pinned to the
    // item even though the list was what rendered.
    it('returns the library path when viewingList is true, even with a stale result (up-crumb)', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'inquiry',
        inquiryStore: {
          jobId: 'job-99',
          viewingList: true,
          result: { request: { question: 'How does transformer attention work?' } },
        } as any,
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
      expect(place.label).toBe('Ask a Question: How does transformer attention work?');
    });

    // t/4888: openCommunityResult() deliberately leaves jobId null (no job to poll for a
    // community item) — the old resolver treated that as "nothing open", dropping the up-crumb.
    it('returns open inquiry path keyed off communityResultId when a community answer is open (t/4888)', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'inquiry',
        inquiryStore: {
          jobId: null,
          communityResultId: 'community-77',
          result: { request: { question: 'What counts as an AI harm?' } },
        } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/inquiry/community-77?community=1');
      expect(place.placeKey).toBe('inquiry:community-77');
      expect(place.label).toBe('Ask a Question: What counts as an AI harm?');
      expect(place.crumbs[0]).toEqual({ text: 'Ask a Question', href: '/inquiry' });
    });

    it('treats a My answer (jobId set) as not community — no query param', () => {
      const state = {
        taxonomyStore: mockTaxonomyStore,
        activeTab: 'inquiry',
        inquiryStore: {
          jobId: 'job-99',
          communityResultId: null,
          result: { request: { question: 'How does transformer attention work?' } },
        } as any,
      };
      const place = placeOf(state as any);
      expect(place.path).toBe('/inquiry/job-99');
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
