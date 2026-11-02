// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useMemo } from 'react';
import './LocationBar.css';

// Breadcrumb type for navigation (will be replaced by types.Crumb when Phase 1 lands)
interface Crumb {
  label: string;
  placeKey: string;
}

interface LocationBarProps {
  crumbs: Crumb[];
  currentPlaceKey: string;
  onNavigate: (placeKey: string) => void;
}

/**
 * LocationBar renders breadcrumbs for the current place in the app hierarchy.
 * Users can click any crumb to navigate back (or up) to that place.
 *
 * Breadcrumb hierarchy: [Rosetta Stone] / [Tool] / [Item in Tool]
 * Clicking a crumb fires onNavigate with its placeKey.
 */
export function LocationBar({ crumbs, currentPlaceKey, onNavigate }: LocationBarProps) {
  // Disable the current crumb (it's where we already are)
  const disabledPlaceKey = useMemo(() => {
    const current = crumbs.find(c => c.placeKey === currentPlaceKey);
    return current?.placeKey;
  }, [crumbs, currentPlaceKey]);

  return (
    <nav className="nav-locbar" aria-label="Breadcrumb navigation">
      {crumbs.map((crumb, index) => (
        <div key={`${crumb.placeKey}-${index}`} className="nav-locbar-item">
          <button
            className="nav-locbar-crumb"
            onClick={() => onNavigate(crumb.placeKey)}
            disabled={crumb.placeKey === disabledPlaceKey}
            aria-current={crumb.placeKey === currentPlaceKey ? 'page' : undefined}
            title={`Go to ${crumb.label}`}
          >
            {crumb.label}
          </button>
          {index < crumbs.length - 1 && (
            <span className="nav-locbar-separator" aria-hidden="true">/</span>
          )}
        </div>
      ))}
    </nav>
  );
}
