// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { MouseEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { NAV_ITEMS } from '../../data/navConfig';
import type { Crumb, PlaceTool } from '../../navigation/types';
import './LocationBar.css';

interface LocationBarProps {
  crumbs: Crumb[];
  tool: PlaceTool;
  /** A plain click on an up-link: navigate in place to `href` (a push). */
  onUp: (href: string) => void;
}

const isWeb = import.meta.env.VITE_TARGET === 'web';

function CrumbText({ crumb }: { crumb: Crumb }) {
  return (
    <>
      {crumb.camp && <span className={`nav-locbar-dot nav-locbar-dot-${crumb.camp}`} aria-hidden="true" />}
      {crumb.text}
    </>
  );
}

/**
 * The breadcrumb half of the location bar (docs/ux/navigation-location-bar.md § Breadcrumb,
 * § Clickable breadcrumb). The tool's rail icon leads; the last crumb is the current place,
 * plain text with `aria-current="location"`. An ancestor is a link only when it leads UP to a
 * different place (`crumb.href`); other ancestors are plain text.
 */
export function LocationBar({ crumbs, tool, onUp }: LocationBarProps) {
  const ToolIcon = NAV_ITEMS.find(item => item.id === tool)?.icon;

  const handleUpClick = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    // Web: Ctrl/⌘/Shift-click keep the browser's default (a new tab or window). Electron has no
    // window type for a collection, so every click there navigates in place.
    if (isWeb && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    onUp(href);
  };

  return (
    <nav className="nav-locbar-crumbs" aria-label="Breadcrumb">
      {ToolIcon && <ToolIcon className="nav-locbar-tool-icon" aria-hidden="true" />}
      <ol>
        {crumbs.map((crumb, index) => {
          const isCurrent = index === crumbs.length - 1;
          if (isCurrent) {
            return (
              <li key={index} className="nav-locbar-crumb nav-locbar-current" aria-current="location" title={crumb.text}>
                <CrumbText crumb={crumb} />
              </li>
            );
          }
          return (
            <li key={index} className="nav-locbar-crumb">
              {crumb.href ? (
                <a href={crumb.href} className="nav-locbar-link" title={`Up to ${crumb.text}`} onClick={e => handleUpClick(e, crumb.href!)}>
                  <CrumbText crumb={crumb} />
                </a>
              ) : (
                <span className="nav-locbar-text" title={crumb.text}><CrumbText crumb={crumb} /></span>
              )}
              <ChevronRight className="nav-locbar-separator" aria-hidden="true" />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
