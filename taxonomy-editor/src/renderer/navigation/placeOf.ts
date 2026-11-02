// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Crumb, PlaceInfo, PlaceTool } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

// Lazy imports to avoid circular dependencies
type DebateStore = ReturnType<typeof import('../hooks/useDebateStore').useDebateStore.getState>;
type ChatStore = ReturnType<typeof import('../hooks/useChatStore').useChatStore.getState>;
type OpEdStore = ReturnType<typeof import('../hooks/useOpEdStore').useOpEdStore.getState>;
type InquiryStore = ReturnType<typeof import('../hooks/useInquiryStore').useInquiryStore.getState>;

export interface AppState {
  taxonomyStore: TaxonomyStore;
  debateStore?: DebateStore;
  opEdStore?: OpEdStore;
  chatStore?: ChatStore;
  inquiryStore?: InquiryStore;
  activeTab: string;
}

type PlaceResolver = (state: AppState) => PlaceInfo;

/**
 * Build a place. `label` is always the last crumb's text, so the bar, the Back tooltip and the
 * Recent menu can never disagree, and an id can't leak into one but not the others.
 */
function place(tool: PlaceTool, path: string, placeKey: string, crumbs: Crumb[]): PlaceInfo {
  return { tool, path, placeKey, label: crumbs[crumbs.length - 1].text, crumbs };
}

/**
 * A tool with a collection and items (§ Breadcrumb table): `Tool` alone on the collection;
 * `Tool › title` on an item, where the tool crumb links up to the collection. While the item's
 * title is still loading (no title), only the tool crumb shows — never its id.
 */
function collectionPlace(tool: PlaceTool, toolName: string, collectionPath: string, item: { id: string; title?: string | null } | null): PlaceInfo {
  if (!item) return place(tool, collectionPath, `${tool}:none`, [{ text: toolName }]);
  const crumbs: Crumb[] = [{ text: toolName, href: collectionPath }];
  if (item.title) crumbs.push({ text: item.title });
  return place(tool, `${collectionPath}/${encodeURIComponent(item.id)}`, `${tool}:${item.id}`, crumbs);
}

const CAMPS: Record<string, { pov: string; name: string; camp?: Crumb['camp'] }> = {
  accelerationist: { pov: 'acc', name: 'Accelerationist', camp: 'acc' },
  safetyist: { pov: 'saf', name: 'Safetyist', camp: 'saf' },
  skeptic: { pov: 'skp', name: 'Skeptic', camp: 'skp' },
  situations: { pov: 'sit', name: 'Situations' },
};

const PLACE_RESOLVERS: Record<string, PlaceResolver> = {
  'rosetta-stone': () => place('rosetta-stone', '/', 'rosetta-stone', [{ text: 'Rosetta Stone' }]),

  'chat': (state) => {
    const chat = state.chatStore?.activeChat;
    return collectionPlace('chat', 'Chat', '/chat', chat ? { id: chat.id, title: chat.topic } : null);
  },

  'opeds': (state) => {
    const store = state.opEdStore;
    const openSet = store?.selectedSetId ? store.sets.find(s => s.set_id === store.selectedSetId) : null;
    return collectionPlace('opeds', 'Op-Ed Studies', '/opeds', openSet ? { id: openSet.set_id, title: openSet.topic } : null);
  },

  'inquiry': (state) => {
    // The inquiry store has no "active inquiry" object: an answer is open when `result` is set,
    // and `jobId` identifies it.
    const store = state.inquiryStore;
    const openId = store?.result ? store.jobId : null;
    return collectionPlace('inquiry', 'Ask a Question', '/inquiry',
      openId ? { id: openId, title: store?.result?.request.question } : null);
  },

  'debate': (state) => {
    const debate = state.debateStore?.activeDebate;
    return collectionPlace('debate', 'Debate', '/debate',
      debate ? { id: debate.id, title: debate.topic.final || debate.topic.original } : null);
  },

  'accelerationist': (state) => resolveTaxonomy('accelerationist', state.taxonomyStore),
  'safetyist': (state) => resolveTaxonomy('safetyist', state.taxonomyStore),
  'skeptic': (state) => resolveTaxonomy('skeptic', state.taxonomyStore),
  'situations': (state) => resolveTaxonomy('situations', state.taxonomyStore),

  'conflicts': (state) => {
    const claimId = state.taxonomyStore.selectedNodeId;
    if (!claimId) return place('conflicts', '/conflicts', 'conflicts:none', [{ text: 'Conflicts' }]);
    const claimLabel = state.taxonomyStore.conflicts?.find(c => c.claim_id === claimId)?.claim_label;
    const crumbs: Crumb[] = [{ text: 'Conflicts', href: '/conflicts' }];
    if (claimLabel) crumbs.push({ text: claimLabel });
    return place('conflicts', `/conflicts?claim=${encodeURIComponent(claimId)}`, `conflicts:${claimId}`, crumbs);
  },

  'cruxes': () => place('cruxes', '/cruxes', 'cruxes:none', [{ text: 'Cruxes' }]),
  'summaries': () => place('summaries', '/summaries', 'summaries:none', [{ text: 'Summaries' }]),
  'validation': () => place('validation', '/validation', 'validation:none', [{ text: 'Validation' }]),
  'organizations': () => place('organizations', '/organizations', 'organizations:none', [{ text: 'Organizations' }]),
};

/**
 * `Taxonomy › ● Camp` and, with a node selected, `› node label`. "Taxonomy" is never a link (it
 * has no collection); the camp links up to the camp with no node selected.
 */
function resolveTaxonomy(tab: string, store: TaxonomyStore): PlaceInfo {
  const { pov, name, camp } = CAMPS[tab];
  const nodeId = store.selectedNodeId;
  const campPath = `/taxonomy/${pov}`;
  const campCrumb: Crumb = camp ? { text: name, camp } : { text: name };
  if (!nodeId) return place('taxonomy', campPath, 'taxonomy:none', [{ text: 'Taxonomy' }, campCrumb]);

  const file = (store as unknown as Record<string, { nodes?: Array<{ id: string; label?: string }> } | null | undefined>)[tab];
  const nodeLabel = file?.nodes?.find(n => n.id === nodeId)?.label;
  const crumbs: Crumb[] = [{ text: 'Taxonomy' }, { ...campCrumb, href: campPath }];
  if (nodeLabel) crumbs.push({ text: nodeLabel });
  return place('taxonomy', `${campPath}?node=${encodeURIComponent(nodeId)}`, `taxonomy:${nodeId}`, crumbs);
}

/**
 * Serializes the current app state into a "place" — a unique location in the app
 * that the user would recognize as "I am on X". Returns path, placeKey, label, tool and crumbs.
 *
 * placeKey is a unique identifier for the place (e.g., 'debate:debate-123', 'chat:conv-42').
 * Different placeKeys always push history; same placeKey with different path replaces.
 *
 * Per-tool open items are keyed off each tool's store (debateStore.activeDebate,
 * chatStore.activeChat, opEdStore.selectedSetId, inquiryStore.result/jobId),
 * NOT off the taxonomy's selectedNodeId.
 */
export function placeOf(state: AppState): PlaceInfo {
  const resolver = PLACE_RESOLVERS[state.activeTab];
  return resolver ? resolver(state) : PLACE_RESOLVERS['rosetta-stone'](state);
}
