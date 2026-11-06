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
 * Build a place. `label` — the short form for Back/Forward names, the Recent menu and the live
 * announcement — is derived from the crumbs, so they can never disagree and an id can't leak into
 * one but not the others. Per the spec it is the last crumb, prefixed with the tool name (the
 * first crumb) when they differ: "Chat: <title>", "Taxonomy: <node>"; just "Chat" on a collection.
 */
function place(tool: PlaceTool, path: string, placeKey: string, crumbs: Crumb[]): PlaceInfo {
  const last = crumbs[crumbs.length - 1].text;
  const toolText = crumbs[0].text;
  const label = crumbs.length > 1 && toolText !== last ? `${toolText}: ${last}` : last;
  return { tool, path, placeKey, label, crumbs };
}

/**
 * A tool with a collection and items (§ Breadcrumb table): `Tool` alone on the collection;
 * `Tool › title` on an item, where the tool crumb links up to the collection. While the item's
 * title is still loading (no title), only the tool crumb shows — never its id.
 *
 * `item.community` (t/4888): a Community item's path carries `?community=1` so a deep link or
 * reload restores it through the community-loading path, not the My one — the two share an item
 * route (appRoutes.ts), distinguished by this query param, same pattern TAXONOMY_ROUTE/
 * CONFLICTS_ROUTE already use for their own query-carried context.
 */
function collectionPlace(tool: PlaceTool, toolName: string, collectionPath: string, item: { id: string; title?: string | null; community?: boolean } | null): PlaceInfo {
  if (!item) return place(tool, collectionPath, `${tool}:none`, [{ text: toolName }]);
  const crumbs: Crumb[] = [{ text: toolName, href: collectionPath }];
  if (item.title) crumbs.push({ text: item.title });
  const query = item.community ? '?community=1' : '';
  return place(tool, `${collectionPath}/${encodeURIComponent(item.id)}${query}`, `${tool}:${item.id}`, crumbs);
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
    // `activeCommunityChat` (t/4888) mirrors ChatTab's own local Community selection, which
    // placeOf.ts otherwise has no visibility into — see useChatStore.ts's comment on the field.
    // Community wins when set (Design review, t/4888#3): opening Community must not clear
    // activeChat, since that would silently drop a reply still generating in the user's own
    // chat (t/4687#1) — so a stale activeChat can coexist with a fresh activeCommunityChat, and
    // the resolver (not a clear-on-select side effect) is what picks the one that's actually open.
    const store = state.chatStore;
    const cc = store?.activeCommunityChat;
    if (cc) return collectionPlace('chat', 'Chat', '/chat', { id: cc.id, title: cc.title, community: true });
    const chat = store?.activeChat;
    return collectionPlace('chat', 'Chat', '/chat', chat ? { id: chat.id, title: chat.topic } : null);
  },

  'opeds': (state) => {
    // `sets` is the My-only index, so a community set's title (and the fact that it IS
    // community) comes from `selectedSetTitle`/`selectedSetIsCommunity` instead (t/4888) —
    // see OpEdStore's comment on those fields.
    const store = state.opEdStore;
    const id = store?.selectedSetId;
    if (!id) return collectionPlace('opeds', 'Op-Ed Studies', '/opeds', null);
    const mySet = store!.sets.find(s => s.set_id === id);
    const title = mySet?.topic ?? store!.selectedSetTitle ?? undefined;
    return collectionPlace('opeds', 'Op-Ed Studies', '/opeds', { id, title, community: !mySet && store!.selectedSetIsCommunity });
  },

  'inquiry': (state) => {
    // The inquiry store has no "active inquiry" object: an answer is open when `result` is set.
    // `jobId` identifies a My run; `communityResultId` identifies a community one (t/4888) —
    // openCommunityResult() deliberately leaves jobId null, since there's no job to poll.
    //
    // `viewingList` wins over a stale `result` (Design review, prod regression, t/4888#6):
    // openList() deliberately does NOT clear result/jobId/communityResultId — a My job kept
    // running in the background while the user browses the list must still be there if they come
    // back — so `result` alone can't tell "open item" from "went up, job still in flight". Without
    // this check, going up left the breadcrumb (and the URL, via the nav subscriber's
    // placeKey-unchanged check) pinned to the item even though the list was what rendered.
    const store = state.inquiryStore;
    const openId = (!store?.viewingList && store?.result) ? (store.jobId ?? store.communityResultId) : null;
    return collectionPlace('inquiry', 'Ask a Question', '/inquiry',
      openId ? { id: openId, title: store?.result?.request.question, community: !store?.jobId } : null);
  },

  'debate': (state) => {
    // `activeCommunityDebate` (t/4888) mirrors DebateTab's own local Community selection,
    // which placeOf.ts otherwise has no visibility into — see sessionSlice.ts's comment.
    // Community wins when set (Design review, t/4888#3): opening Community must not clear
    // activeDebate, since that risks a round in flight — so a stale activeDebate can coexist
    // with a fresh activeCommunityDebate, and the resolver picks the one that's actually open.
    const store = state.debateStore;
    const cd = store?.activeCommunityDebate;
    if (cd) return collectionPlace('debate', 'Debate', '/debate', { id: cd.id, title: cd.title, community: true });
    const debate = store?.activeDebate;
    return collectionPlace('debate', 'Debate', '/debate', debate ? { id: debate.id, title: debate.topic.final || debate.topic.original } : null);
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
