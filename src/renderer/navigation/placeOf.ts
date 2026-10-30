// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { PlaceInfo } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

/**
 * Serializes the current app state into a "place" — a unique location in the app
 * that the user would recognize as "I am on X". Returns path, placeKey, and label.
 *
 * placeKey is a unique identifier for the place (e.g., 'taxonomy:acc-001-042').
 * Different placeKeys always push history; same placeKey with different path replaces.
 */
export function placeOf(state: TaxonomyStore): PlaceInfo {
  const tab = state.activeTab;
  const nodeId = state.selectedNodeId;

  // Rail tabs and other places — map activeTab to route + placeKey
  switch (tab) {
    case 'rosetta-stone':
      return {
        path: '/',
        placeKey: 'rosetta-stone',
        label: 'Rosetta Stone',
      };

    case 'chat':
      return {
        path: nodeId ? `/chat/${nodeId}` : '/chat',
        placeKey: `chat:${nodeId ?? 'none'}`,
        label: nodeId ? `Chat: ${nodeId}` : 'Chat',
      };

    case 'opeds':
      return {
        path: nodeId ? `/opeds/${nodeId}` : '/opeds',
        placeKey: `opeds:${nodeId ?? 'none'}`,
        label: nodeId ? `Op-Ed: ${nodeId}` : 'Op-Ed Studies',
      };

    case 'inquiry':
      return {
        path: nodeId ? `/inquiry/${nodeId}` : '/inquiry',
        placeKey: `inquiry:${nodeId ?? 'none'}`,
        label: nodeId ? `Inquiry: ${nodeId}` : 'Ask a Question',
      };

    case 'debate':
      return {
        path: nodeId ? `/debate/${nodeId}` : '/debate',
        placeKey: `debate:${nodeId ?? 'none'}`,
        label: nodeId ? `Debate: ${nodeId}` : 'Debate',
      };

    case 'accelerationist':
    case 'safetyist':
    case 'skeptic':
    case 'situations':
      // All taxonomy POV tabs are one place; POV is a view
      const povMap: Record<string, string> = {
        'accelerationist': 'acc',
        'safetyist': 'saf',
        'skeptic': 'skp',
        'situations': 'sit',
      };
      const pov = povMap[tab];
      return {
        path: nodeId ? `/taxonomy/${pov}?node=${nodeId}` : `/taxonomy/${pov}`,
        placeKey: `taxonomy:${nodeId ?? 'none'}`,
        label: nodeId ? `Taxonomy: ${nodeId}` : `Taxonomy (${tab})`,
      };

    case 'conflicts':
      return {
        path: nodeId ? `/conflicts?claim=${nodeId}` : '/conflicts',
        placeKey: `conflicts:${nodeId ?? 'none'}`,
        label: nodeId ? `Conflict: ${nodeId}` : 'Conflicts',
      };

    case 'cruxes':
      return {
        path: '/cruxes',
        placeKey: 'cruxes:none',
        label: 'Cruxes',
      };

    case 'summaries':
      return {
        path: '/summaries',
        placeKey: 'summaries:none',
        label: 'Summaries',
      };

    case 'validation':
      return {
        path: '/validation',
        placeKey: 'validation:none',
        label: 'Validation',
      };

    case 'organizations':
      return {
        path: '/organizations',
        placeKey: 'organizations:none',
        label: 'Organizations',
      };

    default:
      // Unknown tab — fall back to landing
      return {
        path: '/',
        placeKey: 'rosetta-stone',
        label: 'Rosetta Stone',
      };
  }
}
