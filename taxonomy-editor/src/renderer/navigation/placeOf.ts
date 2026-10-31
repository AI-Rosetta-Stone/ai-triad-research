// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { PlaceInfo } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

// Lazy imports to avoid circular dependencies
type DebateStore = ReturnType<typeof import('../hooks/useDebateStore').useDebateStore.getState>;
type ChatStore = ReturnType<typeof import('../hooks/useChatStore').useChatStore.getState>;
type OpEdStore = ReturnType<typeof import('../hooks/useOpEdStore').useOpEdStore.getState>;
type InquiryStore = ReturnType<typeof import('../hooks/useInquiryStore').useInquiryStore.getState>;

interface AppState {
  taxonomyStore: TaxonomyStore;
  debateStore?: DebateStore;
  opEdStore?: OpEdStore;
  chatStore?: ChatStore;
  inquiryStore?: InquiryStore;
  activeTab: string;
}

type PlaceResolver = (state: AppState) => PlaceInfo;

const POV_MAP: Record<string, string> = {
  'accelerationist': 'acc',
  'safetyist': 'saf',
  'skeptic': 'skp',
  'situations': 'sit',
};

const PLACE_RESOLVERS: Record<string, PlaceResolver> = {
  'rosetta-stone': () => ({
    path: '/',
    placeKey: 'rosetta-stone',
    label: 'Rosetta Stone',
  }),

  'chat': (state) => {
    const openChat = state.chatStore?.activeChat;
    if (!openChat) {
      return {
        path: '/chat',
        placeKey: 'chat:none',
        label: 'Chat',
      };
    }
    return {
      path: `/chat/${openChat.id}`,
      placeKey: `chat:${openChat.id}`,
      label: openChat.topic || 'Chat',
    };
  },

  'opeds': (state) => {
    const store = state.opEdStore;
    const openSet = store?.selectedSetId ?
      store.sets.find(s => s.set_id === store.selectedSetId) :
      null;
    if (!openSet) {
      return {
        path: '/opeds',
        placeKey: 'opeds:none',
        label: 'Op-Ed Studies',
      };
    }
    return {
      path: `/opeds/${openSet.set_id}`,
      placeKey: `opeds:${openSet.set_id}`,
      label: openSet.topic || 'Op-Ed',
    };
  },

  'inquiry': (state) => {
    const openInquiry = state.inquiryStore?.activeInquiry;
    if (!openInquiry) {
      return {
        path: '/inquiry',
        placeKey: 'inquiry:none',
        label: 'Ask a Question',
      };
    }
    return {
      path: `/inquiry/${openInquiry.id}`,
      placeKey: `inquiry:${openInquiry.id}`,
      label: openInquiry.title || 'Inquiry',
    };
  },

  'debate': (state) => {
    const openDebate = state.debateStore?.activeDebate;
    if (!openDebate) {
      return {
        path: '/debate',
        placeKey: 'debate:none',
        label: 'Debate',
      };
    }
    return {
      path: `/debate/${openDebate.id}`,
      placeKey: `debate:${openDebate.id}`,
      label: openDebate.topic || 'Debate',
    };
  },

  'accelerationist': (state) => resolveTaxonomy('accelerationist', state.taxonomyStore.selectedNodeId),
  'safetyist': (state) => resolveTaxonomy('safetyist', state.taxonomyStore.selectedNodeId),
  'skeptic': (state) => resolveTaxonomy('skeptic', state.taxonomyStore.selectedNodeId),
  'situations': (state) => resolveTaxonomy('situations', state.taxonomyStore.selectedNodeId),

  'conflicts': (state) => {
    const nodeId = state.taxonomyStore.selectedNodeId;
    return {
      path: nodeId ? `/conflicts?claim=${nodeId}` : '/conflicts',
      placeKey: `conflicts:${nodeId ?? 'none'}`,
      label: nodeId ? `Conflict: ${nodeId}` : 'Conflicts',
    };
  },

  'cruxes': () => ({
    path: '/cruxes',
    placeKey: 'cruxes:none',
    label: 'Cruxes',
  }),

  'summaries': () => ({
    path: '/summaries',
    placeKey: 'summaries:none',
    label: 'Summaries',
  }),

  'validation': () => ({
    path: '/validation',
    placeKey: 'validation:none',
    label: 'Validation',
  }),

  'organizations': () => ({
    path: '/organizations',
    placeKey: 'organizations:none',
    label: 'Organizations',
  }),
};

function resolveTaxonomy(tab: string, nodeId: string | null): PlaceInfo {
  const pov = POV_MAP[tab];
  return {
    path: nodeId ? `/taxonomy/${pov}?node=${nodeId}` : `/taxonomy/${pov}`,
    placeKey: `taxonomy:${nodeId ?? 'none'}`,
    label: nodeId ? `Taxonomy: ${nodeId}` : `Taxonomy (${tab})`,
  };
}

/**
 * Serializes the current app state into a "place" — a unique location in the app
 * that the user would recognize as "I am on X". Returns path, placeKey, and label.
 *
 * placeKey is a unique identifier for the place (e.g., 'debate:debate-123', 'chat:conv-42').
 * Different placeKeys always push history; same placeKey with different path replaces.
 *
 * Per-tool open items are keyed off each tool's store (debateStore.activeDebate,
 * chatStore.activeChat, opEdStore.selectedSetId, inquiryStore.activeInquiry),
 * NOT off the taxonomy's selectedNodeId.
 */
export function placeOf(state: AppState): PlaceInfo {
  const resolver = PLACE_RESOLVERS[state.activeTab];
  return resolver ? resolver(state) : PLACE_RESOLVERS['rosetta-stone'](state);
}
