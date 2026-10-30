// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { PlaceInfo } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

type PlaceResolver = (nodeId: string | null) => PlaceInfo;

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

  'chat': (nodeId) => ({
    path: nodeId ? `/chat/${nodeId}` : '/chat',
    placeKey: `chat:${nodeId ?? 'none'}`,
    label: nodeId ? `Chat: ${nodeId}` : 'Chat',
  }),

  'opeds': (nodeId) => ({
    path: nodeId ? `/opeds/${nodeId}` : '/opeds',
    placeKey: `opeds:${nodeId ?? 'none'}`,
    label: nodeId ? `Op-Ed: ${nodeId}` : 'Op-Ed Studies',
  }),

  'inquiry': (nodeId) => ({
    path: nodeId ? `/inquiry/${nodeId}` : '/inquiry',
    placeKey: `inquiry:${nodeId ?? 'none'}`,
    label: nodeId ? `Inquiry: ${nodeId}` : 'Ask a Question',
  }),

  'debate': (nodeId) => ({
    path: nodeId ? `/debate/${nodeId}` : '/debate',
    placeKey: `debate:${nodeId ?? 'none'}`,
    label: nodeId ? `Debate: ${nodeId}` : 'Debate',
  }),

  'accelerationist': (nodeId) => resolveTaxonomy('accelerationist', nodeId),
  'safetyist': (nodeId) => resolveTaxonomy('safetyist', nodeId),
  'skeptic': (nodeId) => resolveTaxonomy('skeptic', nodeId),
  'situations': (nodeId) => resolveTaxonomy('situations', nodeId),

  'conflicts': (nodeId) => ({
    path: nodeId ? `/conflicts?claim=${nodeId}` : '/conflicts',
    placeKey: `conflicts:${nodeId ?? 'none'}`,
    label: nodeId ? `Conflict: ${nodeId}` : 'Conflicts',
  }),

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
 * placeKey is a unique identifier for the place (e.g., 'taxonomy:acc-001-042').
 * Different placeKeys always push history; same placeKey with different path replaces.
 */
export function placeOf(state: TaxonomyStore): PlaceInfo {
  const resolver = PLACE_RESOLVERS[state.activeTab];
  return resolver ? resolver(state.selectedNodeId) : PLACE_RESOLVERS['rosetta-stone'](null);
}
